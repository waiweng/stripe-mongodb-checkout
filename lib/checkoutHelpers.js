const { ObjectId } = require('mongodb');

/**
 * Looks up a Stripe Customer by email, or creates one if none exists.
 * We store the Stripe customer id in MongoDB so future features (saved cards) can reuse it.
 */
async function findOrCreateStripeCustomer(stripe, email, name) {
  const existingList = await stripe.customers.list({
    email: email,
    limit: 1,
  });

  if (existingList.data.length > 0) {
    const existing = existingList.data[0];
    if (name && existing.name !== name) {
      await stripe.customers.update(existing.id, { name: name });
    }
    return existing;
  }

  return stripe.customers.create({
    email: email,
    name: name,
  });
}

/**
 * Inserts or updates a customer row so we always have the latest name and Stripe id for that email.
 */
async function upsertMongoCustomer(customersCollection, name, email, stripeCustomerId) {
  const now = new Date();

  // Look up by email so we reuse one MongoDB customer per shopper instead of creating duplicates.
  const existing = await customersCollection.findOne({ email: email });

  if (existing) {
    // Keep the record in sync when the same email checks out again with updated details.
    await customersCollection.updateOne(
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

  const insertResult = await customersCollection.insertOne({
    name: name,
    email: email,
    stripe_customer_id: stripeCustomerId,
    created_at: now,
  });

  return insertResult.insertedId;
}

/**
 * Creates a pending order row before the customer pays so we can tie MongoDB to the PaymentIntent id.
 */
async function insertPendingOrder(ordersCollection, orderPayload) {
  const now = new Date();

  const document = {
    customer_id: orderPayload.customerId,
    product_id: orderPayload.productId,
    product_title: orderPayload.productTitle,
    amount: orderPayload.amount,
    currency: orderPayload.currency,
    status: 'pending',
    stripe_payment_intent_id: orderPayload.stripePaymentIntentId,
    created_at: now,
    updated_at: now,
  };

  // Persist the pending order so we can join Stripe webhooks back to this purchase using the PaymentIntent id.
  await ordersCollection.insertOne(document);
}

/**
 * Converts a dollar amount stored in MongoDB (e.g. 23.00) to Stripe’s integer smallest-currency-unit amount.
 */
function dollarsToStripeAmount(dollarAmount) {
  return Math.round(Number(dollarAmount) * 100);
}

/**
 * Marks an order completed and decrements product stock in one transaction.
 * Idempotent: if the order is already completed, returns without changing stock again.
 * Fails the transaction if the order is not pending (for example already failed) or stock is insufficient.
 */
async function completeOrderAndDecrementStock(mongoClient, database, paymentIntentId) {
  const session = mongoClient.startSession();

  try {
    await session.withTransaction(async function runCompletionTransaction() {
      const ordersCollection = database.collection('orders');
      const productsCollection = database.collection('products');

      // Load the order tied to this Stripe PaymentIntent so we know which product to decrement.
      const order = await ordersCollection.findOne(
        { stripe_payment_intent_id: paymentIntentId },
        { session: session }
      );

      if (!order) {
        throw new Error('No order found for this PaymentIntent.');
      }

      if (order.status === 'completed') {
        return;
      }

      if (order.status !== 'pending') {
        throw new Error('Order cannot be completed because status is not pending.');
      }

      // Decrement stock first so we never mark an order completed without inventory backing it.
      const stockUpdate = await productsCollection.updateOne(
        { _id: order.product_id, stock: { $gt: 0 } },
        { $inc: { stock: -1 } },
        { session: session }
      );

      if (stockUpdate.modifiedCount !== 1) {
        throw new Error('Insufficient stock to complete this order.');
      }

      const now = new Date();
      const orderUpdate = await ordersCollection.updateOne(
        { _id: order._id, status: 'pending' },
        {
          $set: {
            status: 'completed',
            updated_at: now,
          },
        },
        { session: session }
      );

      if (orderUpdate.modifiedCount !== 1) {
        throw new Error('Order could not be moved to completed.');
      }
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Loads an order by Stripe PaymentIntent id so the confirmation page can show what was purchased.
 */
async function findOrderByPaymentIntentId(ordersCollection, paymentIntentId) {
  // Read the order snapshot we stored when the PaymentIntent was created so the receipt page matches what was sold.
  return ordersCollection.findOne({
    stripe_payment_intent_id: paymentIntentId,
  });
}

/**
 * Validates a product id string and loads the product from MongoDB.
 */
async function getProductByIdString(productsCollection, productIdString) {
  if (!ObjectId.isValid(productIdString)) {
    return null;
  }

  // Load the book from the catalogue so we charge the correct price and copy the title onto the order.
  return productsCollection.findOne({
    _id: new ObjectId(productIdString),
  });
}

/**
 * Persists a Stripe webhook payload for audit and idempotency, then runs business logic for supported types.
 * Duplicate Stripe event ids (retries) reuse the same row and retry processing if the first attempt failed.
 */
async function recordStripeWebhookEventAndProcess(mongoClient, database, stripeEvent, processSucceededCallback) {
  const paymentEventsCollection = database.collection('payment_events');

  try {
    await paymentEventsCollection.insertOne({
      stripe_event_id: stripeEvent.id,
      event_type: stripeEvent.type,
      payload: stripeEvent,
      processed_successfully: false,
      received_at: new Date(),
    });
  } catch (insertError) {
    if (insertError.code !== 11000) {
      throw insertError;
    }
  }

  const eventDoc = await paymentEventsCollection.findOne({ stripe_event_id: stripeEvent.id });

  if (eventDoc.processed_successfully) {
    return;
  }

  try {
    await processSucceededCallback();

    await paymentEventsCollection.updateOne(
      { stripe_event_id: stripeEvent.id },
      {
        $set: {
          processed_successfully: true,
          processing_error: null,
          processed_at: new Date(),
        },
      }
    );
  } catch (processingError) {
    await paymentEventsCollection.updateOne(
      { stripe_event_id: stripeEvent.id },
      {
        $set: {
          processed_successfully: false,
          processing_error: processingError.message,
          processed_at: new Date(),
        },
      }
    );
    throw processingError;
  }
}

module.exports = {
  findOrCreateStripeCustomer,
  upsertMongoCustomer,
  insertPendingOrder,
  completeOrderAndDecrementStock,
  findOrderByPaymentIntentId,
  getProductByIdString,
  dollarsToStripeAmount,
  recordStripeWebhookEventAndProcess,
};
