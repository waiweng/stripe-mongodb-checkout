/**
 * Database seed script: resets the products catalogue and inserts the three
 * Stripe Press books that match the images in /public/images.
 *
 * Run: node seed.js
 */
require('dotenv').config();

const { MongoClient } = require('mongodb');

const PRODUCTS = [
  {
    title: 'The Art of Doing Science and Engineering',
    author: 'Richard Hamming',
    description:
      'The Art of Doing Science and Engineering is a reminder that a childlike capacity for learning and creativity are accessible to everyone.',
    price: 23.00,
    currency: 'usd',
    image_filename: 'art-science-eng.jpg',
    stock: 100,
    created_at: new Date(),
  },
  {
    title: 'The Making of Prince of Persia: Journals 1985-1993',
    author: 'Jordan Mechner',
    description:
      'In The Making of Prince of Persia, on the 30th anniversary of the game’s release, Mechner looks back at the journals he kept from 1985 to 1993.',
    price: 25.00,
    currency: 'usd',
    image_filename: 'prince-of-persia.jpg',
    stock: 100,
    created_at: new Date(),
  },
  {
    title: 'Working in Public: The Making and Maintenance of Open Source',
    author: 'Nadia Eghbal',
    description:
      'Nadia Eghbal takes an inside look at modern open source and offers a model through which to understand the challenges faced by online creators.',
    price: 28.00,
    currency: 'usd',
    image_filename: 'working-in-public.jpg',
    stock: 100,
    created_at: new Date(),
  },
];

async function run() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('Set MONGODB_URI in your .env file.');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();

  const db = client.db('bookstore');

  // Drop the products collection so re-running the seed always matches the catalogue spec.
  await db.collection('products').drop().catch(function () {
    // Collection may not exist on first run; ignore drop errors.
  });

  // Recreate the collection with a fresh set of three books (prices stored as dollar floats, e.g. 23.00).
  await db.collection('products').insertMany(PRODUCTS);

  console.log('Seeded bookstore.products with', PRODUCTS.length, 'documents.');

  // Same unique index as db.js on app startup — creates the payment_events collection so it appears in Atlas even before the first webhook.
  await db.collection('payment_events').createIndex({ stripe_event_id: 1 }, { unique: true });
  console.log('Ensured bookstore.payment_events index (collection visible in Atlas).');

  await client.close();
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
