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

const app = express();
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

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

          // When Stripe confirms payment, complete the order and reduce inventory atomically.
          await completeOrderAndDecrementStock(mongo.client, mongo.db, paymentIntent.id);
        }
      });

      res.json({ received: true });
    } catch (processingError) {
      console.error('Webhook processing failed:', processingError);
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
