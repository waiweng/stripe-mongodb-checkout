/**
 * Seeds the FoodNow demo menu (Malay Kitchen) into MongoDB.
 * Run: node seed-foodnow.js
 */
require('dotenv').config();

const { MongoClient } = require('mongodb');

const MENU = [
  {
    name: 'Laksa',
    description:
      'Rich and spicy coconut milk noodle soup with prawns, tofu puffs, and laksa leaves. A Malaysian classic.',
    price: 18.0,
    currency: 'aud',
    image_filename: 'laksa.jpg',
    restaurant: 'Malay Kitchen',
    stock: 50,
    created_at: new Date(),
  },
  {
    name: 'Char Kuay Teow',
    description:
      'Wok-fried flat rice noodles with tiger prawns, Chinese sausage, eggs, bean sprouts, and chives. Smoky and irresistible.',
    price: 22.0,
    currency: 'aud',
    image_filename: 'char-kuay-teow.jpg',
    restaurant: 'Malay Kitchen',
    stock: 50,
    created_at: new Date(),
  },
  {
    name: 'Nasi Lemak',
    description:
      'Fragrant coconut milk rice served with crispy anchovies, roasted peanuts, cucumber, boiled egg, and house-made sambal.',
    price: 14.0,
    currency: 'aud',
    image_filename: 'nasi-lemak.jpg',
    restaurant: 'Malay Kitchen',
    stock: 50,
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

  await db.collection('foodnow_menu').drop().catch(function () {});

  await db.collection('foodnow_menu').insertMany(MENU);

  console.log('Seeded bookstore.foodnow_menu with', MENU.length, 'items.');
  await client.close();
}

run().catch(function (error) {
  console.error(error);
  process.exit(1);
});
