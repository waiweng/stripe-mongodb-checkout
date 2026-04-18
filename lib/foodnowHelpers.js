/*
 * FoodNow Demo — Stripe Connect + Billing
 *
 * DEMO TALKING POINTS:
 *
 * 1. CONNECT (destination charge model):
 *    When a customer pays AU$22 for Char Kuay Teow:
 *    - Stripe receives AU$22
 *    - Stripe sends AU$18.70 to Malay Kitchen's Stripe account
 *    - FoodNow retains AU$3.30 as platform fee (15%)
 *    - This happens automatically in ONE PaymentIntent
 *    - No manual transfers, no reconciliation headache
 *    - stripe_payment_intent_id links MongoDB order to Stripe
 *
 * 2. BILLING (subscription):
 *    FoodNow Plus = AU$9.90/month
 *    - Stripe Billing handles recurring charge automatically
 *    - Failed payments trigger dunning (automatic retry)
 *    - Customer can cancel via Stripe Customer Portal
 *    - sub_ ID stored in MongoDB for order entitlement checks
 *
 * 3. WHAT TO SHOW IN STRIPE DASHBOARD:
 *    - Payment appears with application_fee shown separately
 *    - Connected account (Malay Kitchen) shows their portion
 *    - Subscription appears under Billing tab
 */

const fs = require('fs');
const path = require('path');
const { ObjectId } = require('mongodb');
const { findOrCreateStripeCustomer, dollarsToStripeAmount } = require('./checkoutHelpers');

/**
 * Loads a menu item by MongoDB id string from foodnow_menu.
 */
async function getMenuItemByIdString(menuCollection, menuItemIdString) {
  if (!ObjectId.isValid(menuItemIdString)) {
    return null;
  }

  return menuCollection.findOne({
    _id: new ObjectId(menuItemIdString),
  });
}

/**
 * Inserts or updates a FoodNow customer row so we can link orders and subscriptions to the same person.
 */
async function upsertFoodnowCustomer(foodnowCustomersCollection, name, email, stripeCustomerId) {
  const now = new Date();

  const existing = await foodnowCustomersCollection.findOne({ email: email });

  if (existing) {
    await foodnowCustomersCollection.updateOne(
      { _id: existing._id },
      {
        $set: {
          name: name,
          stripe_customer_id: stripeCustomerId,
        },
      }
    );
    return existing._id;
  }

  const insertResult = await foodnowCustomersCollection.insertOne({
    name: name,
    email: email,
    stripe_customer_id: stripeCustomerId,
    created_at: now,
  });

  return insertResult.insertedId;
}

/**
 * Persists FOODNOW_PLUS_PRICE_ID into the local .env file after creating a Price in Stripe (dev convenience).
 */
function appendOrUpdateFoodnowPlusPriceIdInEnv(priceId) {
  const envPath = path.join(__dirname, '..', '.env');
  const key = 'FOODNOW_PLUS_PRICE_ID';
  const newLine = `${key}=${priceId}\n`;

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, newLine, 'utf8');
    process.env.FOODNOW_PLUS_PRICE_ID = priceId;
    return;
  }

  let content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split(/\r?\n/);
  let found = false;
  const updated = lines.map(function (line) {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${priceId}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}=${priceId}`);
  }

  fs.writeFileSync(envPath, updated.join('\n'), 'utf8');
  process.env.FOODNOW_PLUS_PRICE_ID = priceId;
}

/**
 * Returns the Stripe Price id for FoodNow Plus, creating the Price once if it is not in the environment.
 */
async function ensureFoodNowPlusPriceId(stripe) {
  let priceId = process.env.FOODNOW_PLUS_PRICE_ID;

  if (priceId && priceId.startsWith('price_')) {
    return priceId;
  }

  // Create a recurring monthly price for AU$9.90 — used by Stripe Billing for FoodNow Plus.
  const price = await stripe.prices.create({
    unit_amount: 990,
    currency: 'aud',
    recurring: { interval: 'month' },
    product_data: {
      name: 'FoodNow Plus',
    },
  });

  appendOrUpdateFoodnowPlusPriceIdInEnv(price.id);
  return price.id;
}

// This is the core Connect demonstration:
// The customer pays the full amount, Stripe automatically routes
// (amount - platform_fee) to the restaurant's connected account,
// and retains the platform_fee for FoodNow. This happens in a
// single PaymentIntent — no manual transfers needed.

/**
 * Creates a destination-charge PaymentIntent on the platform: full charge amount, application fee to FoodNow, transfer to the restaurant Connect account.
 * Returns client secret and a fee breakdown for the checkout UI.
 */
async function createFoodPaymentIntent(stripe, database, params) {
  const menuItemId = params.menuItemId;
  const customerName = params.customerName;
  const customerEmail = params.customerEmail;

  const menuCollection = database.collection('foodnow_menu');
  const foodnowCustomersCollection = database.collection('foodnow_customers');

  const menuItem = await getMenuItemByIdString(menuCollection, menuItemId);

  if (!menuItem) {
    throw new Error('Menu item not found.');
  }

  if (menuItem.stock < 1) {
    throw new Error('This dish is out of stock.');
  }

  const destinationAccountId =
    process.env.RESTAURANT_CONNECTED_ACCOUNT_ID || readConnectedAccountIdFile();

  if (!destinationAccountId || !destinationAccountId.startsWith('acct_')) {
    throw new Error('Set RESTAURANT_CONNECTED_ACCOUNT_ID in .env (run node setup-connect.js first).');
  }

  // Stripe Customer on the platform account — used for receipts and future saved payment methods.
  const stripeCustomer = await findOrCreateStripeCustomer(stripe, customerEmail, customerName);

  const mongoCustomerId = await upsertFoodnowCustomer(
    foodnowCustomersCollection,
    customerName,
    customerEmail,
    stripeCustomer.id
  );

  const itemPriceInCents = dollarsToStripeAmount(menuItem.price);
  const platformFeePercent = Number(process.env.PLATFORM_FEE_PERCENT || 15);
  const platformFeeAmount = Math.round(itemPriceInCents * (platformFeePercent / 100));

  /*
   * Destination charge (Connect) — how the money moves in one API call:
   * - The PaymentIntent charges the customer’s card for the full `amount` (e.g. 2200 cents = AU$22.00).
   * - `transfer_data.destination` is the connected Express account (Malay Kitchen). Stripe credits that account with
   *   (amount − application_fee_amount) after the charge succeeds — here AU$22.00 − AU$3.30 = AU$18.70 to the restaurant.
   * - `application_fee_amount` is the platform’s revenue (FoodNow’s 15% fee) retained on the platform balance.
   * - No separate Transfer API is required; reconciliation is automatic and the PaymentIntent id is the single source of truth.
   */
  const paymentIntent = await stripe.paymentIntents.create({
    amount: itemPriceInCents,
    currency: menuItem.currency,
    customer: stripeCustomer.id,
    payment_method_types: ['card'],
    transfer_data: {
      destination: destinationAccountId,
    },
    application_fee_amount: platformFeeAmount,
    metadata: {
      menu_item_id: menuItem._id.toString(),
      restaurant: 'Malay Kitchen',
      platform_fee_aud: (platformFeeAmount / 100).toFixed(2),
      order_type: 'foodnow',
    },
  });

  const platformFeeDollars = platformFeeAmount / 100;
  const totalDollars = menuItem.price;
  const restaurantReceivesDollars = totalDollars - platformFeeDollars;

  const foodnowOrdersCollection = database.collection('foodnow_orders');
  const now = new Date();

  await foodnowOrdersCollection.insertOne({
    customer_id: mongoCustomerId,
    menu_item_id: menuItem._id,
    item_name: menuItem.name,
    amount: totalDollars,
    platform_fee: platformFeeDollars,
    restaurant_receives: restaurantReceivesDollars,
    currency: menuItem.currency,
    status: 'pending',
    stripe_payment_intent_id: paymentIntent.id,
    created_at: now,
    updated_at: now,
  });

  return {
    clientSecret: paymentIntent.client_secret,
    platformFee: platformFeeDollars.toFixed(2),
    restaurantName: menuItem.restaurant,
    totalAmount: totalDollars.toFixed(2),
    restaurantReceives: restaurantReceivesDollars.toFixed(2),
  };
}

function readConnectedAccountIdFile() {
  try {
    const p = path.join(__dirname, '..', '.connected-account-id');
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf8').trim();
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * Marks a FoodNow order completed and decrements menu stock in one MongoDB transaction (same pattern as the bookstore).
 */
async function completeFoodnowOrderAndStock(mongoClient, database, paymentIntentId) {
  const session = mongoClient.startSession();

  try {
    await session.withTransaction(async function () {
      const ordersCollection = database.collection('foodnow_orders');
      const menuCollection = database.collection('foodnow_menu');

      const order = await ordersCollection.findOne(
        { stripe_payment_intent_id: paymentIntentId },
        { session: session }
      );

      if (!order) {
        throw new Error('No FoodNow order found for this PaymentIntent.');
      }

      if (order.status === 'completed') {
        return;
      }

      if (order.status !== 'pending') {
        throw new Error('FoodNow order cannot be completed from this status.');
      }

      const stockUpdate = await menuCollection.updateOne(
        { _id: order.menu_item_id, stock: { $gt: 0 } },
        { $inc: { stock: -1 } },
        { session: session }
      );

      if (stockUpdate.modifiedCount !== 1) {
        throw new Error('Insufficient stock for this FoodNow order.');
      }

      const orderUpdate = await ordersCollection.updateOne(
        { _id: order._id, status: 'pending' },
        {
          $set: {
            status: 'completed',
            updated_at: new Date(),
          },
        },
        { session: session }
      );

      if (orderUpdate.modifiedCount !== 1) {
        throw new Error('FoodNow order could not be marked completed.');
      }
    });
  } finally {
    await session.endSession();
  }
}

async function findFoodnowOrderByPaymentIntentId(ordersCollection, paymentIntentId) {
  return ordersCollection.findOne({
    stripe_payment_intent_id: paymentIntentId,
  });
}

/**
 * After Stripe successfully charges a FoodNow Plus invoice (first payment or renewal), align MongoDB status with Stripe Billing.
 */
async function markFoodnowSubscriptionActiveIfPending(database, stripeSubscriptionId) {
  const foodnowSubscriptionsCollection = database.collection('foodnow_subscriptions');

  await foodnowSubscriptionsCollection.updateOne(
    { stripe_subscription_id: stripeSubscriptionId },
    {
      $set: {
        status: 'active',
        updated_at: new Date(),
      },
    }
  );
}

/**
 * Creates a Stripe Billing subscription in an incomplete state so the customer must confirm the first invoice with the Payment Element.
 * Persists a pending row in foodnow_subscriptions and returns the PaymentIntent client_secret from the first invoice.
 */
async function createFoodNowPlusSubscription(stripe, database, params) {
  const customerName = params.customerName;
  const customerEmail = params.customerEmail;

  const foodnowCustomersCollection = database.collection('foodnow_customers');
  const foodnowSubscriptionsCollection = database.collection('foodnow_subscriptions');

  const stripeCustomer = await findOrCreateStripeCustomer(stripe, customerEmail, customerName);

  const mongoCustomerId = await upsertFoodnowCustomer(
    foodnowCustomersCollection,
    customerName,
    customerEmail,
    stripeCustomer.id
  );

  const priceId = await ensureFoodNowPlusPriceId(stripe);

  // Subscription with default_incomplete: first invoice is unpaid until the customer completes Payment Element authentication.
  const subscription = await stripe.subscriptions.create({
    customer: stripeCustomer.id,
    items: [{ price: priceId }],
    payment_behavior: 'default_incomplete',
    payment_settings: {
      save_default_payment_method: 'on_subscription',
    },
    expand: ['latest_invoice.payment_intent'],
    metadata: {
      plan: 'FoodNow Plus',
      benefit: 'Free delivery on all orders',
    },
  });

  const invoice = subscription.latest_invoice;
  const paymentIntent = invoice && invoice.payment_intent;

  if (!paymentIntent || !paymentIntent.client_secret) {
    throw new Error('Subscription did not return a PaymentIntent client secret.');
  }

  const now = new Date();

  await foodnowSubscriptionsCollection.insertOne({
    customer_id: mongoCustomerId,
    stripe_customer_id: stripeCustomer.id,
    stripe_subscription_id: subscription.id,
    plan: 'FoodNow Plus',
    amount: 9.9,
    currency: 'aud',
    status: 'pending',
    created_at: now,
  });

  return {
    clientSecret: paymentIntent.client_secret,
    subscriptionId: subscription.id,
  };
}

module.exports = {
  getMenuItemByIdString,
  upsertFoodnowCustomer,
  createFoodPaymentIntent,
  createFoodNowPlusSubscription,
  completeFoodnowOrderAndStock,
  findFoodnowOrderByPaymentIntentId,
  markFoodnowSubscriptionActiveIfPending,
};
