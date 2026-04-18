const express = require('express');
const path = require('path');
const exphbs = require('express-handlebars');
require('dotenv').config();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongo = require('./db');
const {
  findOrCreateStripeCustomer,
  upsertMongoCustomer,
  insertPendingOrder,
  completeOrderAndDecrementStock,
  findOrderByPaymentIntentId,
  getProductByIdString,
  dollarsToStripeAmount,
  recordStripeWebhookEventAndProcess,
} = require('./lib/checkoutHelpers');

const {
  createFoodPaymentIntent,
  createFoodNowPlusSubscription,
  completeFoodnowOrderAndStock,
  findFoodnowOrderByPaymentIntentId,
  getMenuItemByIdString,
  markFoodnowSubscriptionActiveIfPending,
} = require('./lib/foodnowHelpers');

const app = express();
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripeWebhookSecretFoodnow =
  process.env.STRIPE_WEBHOOK_SECRET_FOODNOW || process.env.STRIPE_WEBHOOK_SECRET;

// View engine (Handlebars renders server-side HTML we can style with plain CSS).
app.engine(
  'hbs',
  exphbs({
    defaultLayout: 'main',
    extname: '.hbs',
  })
);
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

/**
 * Stripe webhooks must receive the raw request body for signature verification.
 * This route is registered before express.json() so the payload is not parsed as JSON.
 * Every event is stored in payment_events for audit; payment_intent.succeeded completes the order and decrements stock in a transaction.
 */
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async function handleStripeWebhook(req, res) {
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], stripeWebhookSecret);
    } catch (error) {
      console.error('Webhook signature verification failed:', error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      await recordStripeWebhookEventAndProcess(mongo.client, mongo.db, event, async function runEventBusinessLogic() {
        if (event.type === 'payment_intent.succeeded') {
          const paymentIntent = event.data.object;

          // FoodNow Connect orders carry metadata so we complete foodnow_orders and foodnow_menu stock instead of bookstore orders.
          if (paymentIntent.metadata && paymentIntent.metadata.order_type === 'foodnow') {
            await completeFoodnowOrderAndStock(mongo.client, mongo.db, paymentIntent.id);
          } else {
            // When Stripe confirms payment, complete the book order and reduce inventory atomically.
            await completeOrderAndDecrementStock(mongo.client, mongo.db, paymentIntent.id);
          }
        }

        if (event.type === 'invoice.payment_succeeded') {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;

          if (typeof subscriptionId === 'string') {
            await markFoodnowSubscriptionActiveIfPending(mongo.db, subscriptionId);
          }
        }
      });

      res.json({ received: true });
    } catch (processingError) {
      console.error('Webhook processing failed:', processingError);
      return res.status(500).json({ received: false });
    }
  }
);

/**
 * Optional second webhook URL for FoodNow-only demos: same event types as the main handler for payment_intent.succeeded (food) and invoice.payment_succeeded (subscriptions).
 * Uses STRIPE_WEBHOOK_SECRET_FOODNOW when set, otherwise falls back to STRIPE_WEBHOOK_SECRET.
 */
app.post(
  '/foodnow/webhook',
  express.raw({ type: 'application/json' }),
  async function handleFoodnowStripeWebhook(req, res) {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        stripeWebhookSecretFoodnow
      );
    } catch (error) {
      console.error('FoodNow webhook signature verification failed:', error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      await recordStripeWebhookEventAndProcess(mongo.client, mongo.db, event, async function runFoodnowWebhookLogic() {
        if (event.type === 'payment_intent.succeeded') {
          const paymentIntent = event.data.object;

          if (paymentIntent.metadata && paymentIntent.metadata.order_type === 'foodnow') {
            await completeFoodnowOrderAndStock(mongo.client, mongo.db, paymentIntent.id);
          }
        }

        if (event.type === 'invoice.payment_succeeded') {
          const invoice = event.data.object;
          const subscriptionId = invoice.subscription;

          if (typeof subscriptionId === 'string') {
            await markFoodnowSubscriptionActiveIfPending(mongo.db, subscriptionId);
          }
        }
      });

      res.json({ received: true });
    } catch (processingError) {
      console.error('FoodNow webhook processing failed:', processingError);
      return res.status(500).json({ received: false });
    }
  }
);

app.use(express.json());

/**
 * Renders the home page and lists every book from the products collection so shoppers can choose one title.
 */
app.get('/', async function renderHomePage(req, res) {
  try {
    const productsCollection = mongo.db.collection('products');

    // Read the full catalogue so the storefront always reflects what is stored in MongoDB.
    const productsRaw = await productsCollection.find({}).sort({ created_at: 1 }).toArray();

    const products = productsRaw.map(function mapProductForView(product) {
      return {
        id: product._id.toString(),
        title: product.title,
        author: product.author,
        description: product.description,
        priceLabel: Number(product.price).toFixed(2),
        stock: product.stock,
        imageUrl: '/images/' + product.image_filename,
      };
    });

    res.render('index', { products: products });
  } catch (error) {
    console.error(error);
    res.status(500).render('index', {
      products: [],
      error: 'Unable to load products. Check MongoDB connection and run the seed script.',
    });
  }
});

/**
 * Shows checkout for one product: summary, buyer form, and (after the client requests a PaymentIntent) the Stripe Payment Element.
 */
app.get('/checkout', async function renderCheckoutPage(req, res) {
  const productId = req.query.productId;

  if (!productId) {
    return res.status(400).render('checkout', {
      pageError: 'Please choose a book from the home page.',
    });
  }

  try {
    const productsCollection = mongo.db.collection('products');
    const product = await getProductByIdString(productsCollection, productId);

    if (!product) {
      return res.status(404).render('checkout', {
        pageError: 'That book could not be found.',
      });
    }

    if (product.stock < 1) {
      return res.status(400).render('checkout', {
        pageError: 'This book is currently out of stock.',
      });
    }

    const baseUrl = req.protocol + '://' + req.get('host');
    const returnUrl = baseUrl + '/confirmation?payment_intent={PAYMENT_INTENT_ID}';

    res.render('checkout', {
      productId: product._id.toString(),
      title: product.title,
      author: product.author,
      amountLabel: Number(product.price).toFixed(2),
      stock: product.stock,
      currency: product.currency,
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      returnUrl: returnUrl,
      loadStripeScript: true,
      loadCheckoutScript: true,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('checkout', {
      pageError: 'Something went wrong loading checkout.',
    });
  }
});

/**
 * Creates a Stripe Customer and PaymentIntent, records the customer and a pending order in MongoDB, and returns the PaymentIntent client_secret for the Payment Element.
 */
app.post('/create-payment-intent', async function createPaymentIntentRoute(req, res) {
  const productId = req.body.productId;
  const customerName = req.body.customerName;
  const customerEmail = req.body.customerEmail;

  if (!productId || !customerName || !customerEmail) {
    return res.status(400).json({ error: 'productId, customerName, and customerEmail are required.' });
  }

  let product;

  try {
    const productsCollection = mongo.db.collection('products');
    product = await getProductByIdString(productsCollection, productId);

    if (!product) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    if (product.stock < 1) {
      return res.status(400).json({ error: 'This book is out of stock.' });
    }

    let stripeCustomer;

    // Attach the charge to a Stripe Customer so receipts and future saved payment methods have a stable identity.
    stripeCustomer = await findOrCreateStripeCustomer(stripe, customerEmail, customerName);

    const customersCollection = mongo.db.collection('customers');
    const mongoCustomerId = await upsertMongoCustomer(
      customersCollection,
      customerName,
      customerEmail,
      stripeCustomer.id
    );

    // Stripe expects amount in the smallest currency unit (cents) while MongoDB stores dollars as a decimal number.
    const amountInCents = dollarsToStripeAmount(product.price);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: product.currency,
      customer: stripeCustomer.id,
      payment_method_types: ['card'],
      metadata: {
        product_id: product._id.toString(),
      },
    });

    const ordersCollection = mongo.db.collection('orders');

    // Record the sale attempt as pending until Stripe tells us the payment succeeded.
    await insertPendingOrder(ordersCollection, {
      customerId: mongoCustomerId,
      productId: product._id,
      productTitle: product.title,
      amount: product.price,
      currency: product.currency,
      stripePaymentIntentId: paymentIntent.id,
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
});

/**
 * After the browser returns from Stripe, this page shows the receipt details and sets the order to completed in MongoDB.
 */
app.get('/confirmation', async function renderConfirmationPage(req, res) {
  const paymentIntentId = req.query.payment_intent;

  if (!paymentIntentId) {
    return res.status(400).render('confirmation', {
      error: 'Missing payment confirmation. Start again from the shop.',
    });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).render('confirmation', {
        error: 'Payment was not completed. Your card may have been declined or the payment cancelled.',
        paymentIntentId: paymentIntentId,
      });
    }

    // Mirror the webhook: complete the order and decrement stock in one transaction.
    await completeOrderAndDecrementStock(mongo.client, mongo.db, paymentIntentId);

    const ordersCollection = mongo.db.collection('orders');
    const order = await findOrderByPaymentIntentId(ordersCollection, paymentIntentId);

    if (!order) {
      return res.status(404).render('confirmation', {
        error: 'We could not find your order record.',
        paymentIntentId: paymentIntentId,
      });
    }

    res.render('confirmation', {
      bookTitle: order.product_title,
      amountCharged: Number(order.amount).toFixed(2),
      currency: order.currency.toUpperCase(),
      paymentIntentId: paymentIntentId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('confirmation', {
      error: 'Could not verify this payment with Stripe.',
    });
  }
});

/**
 * FoodNow home: lists Malay Kitchen dishes from foodnow_menu for the demo storefront.
 */
app.get('/foodnow', async function renderFoodnowHome(req, res) {
  try {
    const menuCollection = mongo.db.collection('foodnow_menu');

    const itemsRaw = await menuCollection.find({}).sort({ name: 1 }).toArray();

    const menuItems = itemsRaw.map(function mapMenuItem(item) {
      return {
        id: item._id.toString(),
        name: item.name,
        description: item.description,
        priceLabel: Number(item.price).toFixed(2),
        stock: item.stock,
        imageUrl: '/images/' + item.image_filename,
      };
    });

    res.render('foodnow/index', {
      menuItems: menuItems,
      foodnowLayout: true,
      pageTitle: 'FoodNow — Malay Kitchen',
      loadStripeScript: false,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('foodnow/index', {
      menuItems: [],
      foodnowLayout: true,
      pageTitle: 'FoodNow',
      error: 'Unable to load menu. Run node seed-foodnow.js and check MongoDB.',
    });
  }
});

/**
 * Food order checkout: one dish, transparent platform fee breakdown, then Payment Element after the server creates a Connect PaymentIntent.
 */
app.get('/foodnow/checkout', async function renderFoodnowCheckout(req, res) {
  const menuItemId = req.query.menuItemId;

  if (!menuItemId) {
    return res.status(400).render('foodnow/checkout', {
      foodnowLayout: true,
      pageTitle: 'FoodNow Checkout',
      pageError: 'Choose a dish from the FoodNow home page.',
    });
  }

  try {
    const menuCollection = mongo.db.collection('foodnow_menu');
    const menuItem = await getMenuItemByIdString(menuCollection, menuItemId);

    if (!menuItem) {
      return res.status(404).render('foodnow/checkout', {
        foodnowLayout: true,
        pageTitle: 'FoodNow Checkout',
        pageError: 'That menu item could not be found.',
      });
    }

    if (menuItem.stock < 1) {
      return res.status(400).render('foodnow/checkout', {
        foodnowLayout: true,
        pageTitle: 'FoodNow Checkout',
        pageError: 'This dish is currently out of stock.',
      });
    }

    const platformFeePercent = Number(process.env.PLATFORM_FEE_PERCENT || 15);
    const itemPriceInCents = dollarsToStripeAmount(menuItem.price);
    const platformFeeCents = Math.round(itemPriceInCents * (platformFeePercent / 100));
    const platformFeeDollars = platformFeeCents / 100;
    const totalDollars = Number(menuItem.price);
    const restaurantReceivesDollars = totalDollars - platformFeeDollars;

    const baseUrl = req.protocol + '://' + req.get('host');
    const returnUrl = baseUrl + '/foodnow/confirmation?payment_intent={PAYMENT_INTENT_ID}';

    res.render('foodnow/checkout', {
      foodnowLayout: true,
      pageTitle: 'FoodNow Checkout',
      menuItemId: menuItem._id.toString(),
      dishName: menuItem.name,
      restaurantName: menuItem.restaurant,
      amountLabel: totalDollars.toFixed(2),
      platformFeeLabel: platformFeeDollars.toFixed(2),
      restaurantReceivesLabel: restaurantReceivesDollars.toFixed(2),
      platformFeePercent: platformFeePercent,
      currency: menuItem.currency,
      stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      returnUrl: returnUrl,
      loadStripeScript: true,
      loadFoodnowCheckoutScript: true,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('foodnow/checkout', {
      foodnowLayout: true,
      pageTitle: 'FoodNow Checkout',
      pageError: 'Something went wrong loading checkout.',
    });
  }
});

/**
 * Creates a Connect destination-charge PaymentIntent, upserts foodnow_customers, and inserts a pending foodnow_orders row for webhook completion.
 */
app.post('/foodnow/create-payment-intent', async function createFoodnowPaymentIntentRoute(req, res) {
  const menuItemId = req.body.menuItemId;
  const customerName = req.body.customerName;
  const customerEmail = req.body.customerEmail;

  if (!menuItemId || !customerName || !customerEmail) {
    return res.status(400).json({ error: 'menuItemId, customerName, and customerEmail are required.' });
  }

  try {
    const result = await createFoodPaymentIntent(stripe, mongo.db, {
      menuItemId: menuItemId,
      customerName: customerName,
      customerEmail: customerEmail,
    });

    res.json({
      clientSecret: result.clientSecret,
      platformFee: result.platformFee,
      restaurantName: result.restaurantName,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not start payment. Please try again.' });
  }
});

/**
 * After redirect from Stripe, shows the food receipt and completes the order if the main webhook has not run yet.
 */
app.get('/foodnow/confirmation', async function renderFoodnowConfirmation(req, res) {
  const paymentIntentId = req.query.payment_intent;

  if (!paymentIntentId) {
    return res.status(400).render('foodnow/confirmation', {
      foodnowLayout: true,
      pageTitle: 'FoodNow — Order',
      error: 'Missing payment confirmation. Start again from FoodNow.',
    });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).render('foodnow/confirmation', {
        foodnowLayout: true,
        pageTitle: 'FoodNow — Order',
        error: 'Payment was not completed. Your card may have been declined or the payment cancelled.',
        paymentIntentId: paymentIntentId,
      });
    }

    await completeFoodnowOrderAndStock(mongo.client, mongo.db, paymentIntentId);

    const ordersCollection = mongo.db.collection('foodnow_orders');
    const order = await findFoodnowOrderByPaymentIntentId(ordersCollection, paymentIntentId);

    if (!order) {
      return res.status(404).render('foodnow/confirmation', {
        foodnowLayout: true,
        pageTitle: 'FoodNow — Order',
        error: 'We could not find your FoodNow order record.',
        paymentIntentId: paymentIntentId,
      });
    }

    res.render('foodnow/confirmation', {
      foodnowLayout: true,
      pageTitle: 'FoodNow — Order confirmed',
      dishName: order.item_name,
      amountPaid: Number(order.amount).toFixed(2),
      platformFee: Number(order.platform_fee).toFixed(2),
      restaurantReceives: Number(order.restaurant_receives).toFixed(2),
      paymentIntentId: paymentIntentId,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('foodnow/confirmation', {
      foodnowLayout: true,
      pageTitle: 'FoodNow — Order',
      error: 'Could not verify this payment with Stripe.',
    });
  }
});

/**
 * FoodNow Plus subscription landing page with benefits and Payment Element (after create-subscription returns a client secret).
 */
app.get('/foodnow/subscribe', async function renderFoodnowSubscribe(req, res) {
  const baseUrl = req.protocol + '://' + req.get('host');
  const returnUrl = baseUrl + '/foodnow/subscription-confirmation?payment_intent={PAYMENT_INTENT_ID}';

  res.render('foodnow/subscribe', {
    foodnowLayout: true,
    pageTitle: 'FoodNow Plus',
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    returnUrl: returnUrl,
    loadStripeScript: true,
    loadFoodnowSubscribeScript: true,
  });
});

/**
 * Creates an incomplete Stripe Billing subscription and returns the first invoice PaymentIntent client_secret for the Payment Element.
 */
app.post('/foodnow/create-subscription', async function createFoodnowSubscriptionRoute(req, res) {
  const customerName = req.body.customerName;
  const customerEmail = req.body.customerEmail;

  if (!customerName || !customerEmail) {
    return res.status(400).json({ error: 'customerName and customerEmail are required.' });
  }

  try {
    const result = await createFoodNowPlusSubscription(stripe, mongo.db, {
      customerName: customerName,
      customerEmail: customerEmail,
    });

    res.json({
      clientSecret: result.clientSecret,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Could not start subscription. Please try again.' });
  }
});

/**
 * Confirms subscription signup after Stripe redirects back with the PaymentIntent that paid the first invoice.
 */
app.get('/foodnow/subscription-confirmation', async function renderFoodnowSubscriptionConfirmation(req, res) {
  const paymentIntentId = req.query.payment_intent;

  if (!paymentIntentId) {
    return res.status(400).render('foodnow/subscription-confirmation', {
      foodnowLayout: true,
      pageTitle: 'FoodNow Plus',
      error: 'Missing subscription confirmation. Start again from the subscribe page.',
    });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['invoice.subscription'],
    });

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).render('foodnow/subscription-confirmation', {
        foodnowLayout: true,
        pageTitle: 'FoodNow Plus',
        error: 'The subscription payment was not completed.',
        paymentIntentId: paymentIntentId,
      });
    }

    let subscriptionId = null;
    let nextBillingTimestamp = null;

    if (paymentIntent.invoice) {
      let invoice = paymentIntent.invoice;

      if (typeof invoice === 'string') {
        invoice = await stripe.invoices.retrieve(invoice, {
          expand: ['subscription'],
        });
      }

      let sub = invoice.subscription;

      if (typeof sub === 'string') {
        subscriptionId = sub;
      } else if (sub && sub.id) {
        subscriptionId = sub.id;
        if (sub.current_period_end) {
          nextBillingTimestamp = sub.current_period_end;
        }
      }

      if (subscriptionId && !nextBillingTimestamp) {
        const fullSub = await stripe.subscriptions.retrieve(subscriptionId);
        nextBillingTimestamp = fullSub.current_period_end;
      }
    }

    if (!subscriptionId) {
      return res.status(400).render('foodnow/subscription-confirmation', {
        foodnowLayout: true,
        pageTitle: 'FoodNow Plus',
        error: 'Could not read subscription details from Stripe.',
      });
    }

    await markFoodnowSubscriptionActiveIfPending(mongo.db, subscriptionId);

    const nextBillingDate = nextBillingTimestamp
      ? new Date(nextBillingTimestamp * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const nextBillingLabel = nextBillingDate.toLocaleDateString('en-AU', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    res.render('foodnow/subscription-confirmation', {
      foodnowLayout: true,
      pageTitle: 'Welcome to FoodNow Plus',
      subscriptionId: subscriptionId,
      nextBillingLabel: nextBillingLabel,
    });
  } catch (error) {
    console.error(error);
    res.status(500).render('foodnow/subscription-confirmation', {
      foodnowLayout: true,
      pageTitle: 'FoodNow Plus',
      error: 'Could not verify your subscription with Stripe.',
    });
  }
});

const port = process.env.PORT || 3000;

mongo.connectToMongoDB()
  .then(function onConnected() {
    app.listen(port, function onListen() {
      console.log('Bookstore server listening on port ' + port);
    });
  })
  .catch(function onConnectError(error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  });
