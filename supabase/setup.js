require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Connected to Supabase PostgreSQL');

  const sql = fs.readFileSync(path.join(__dirname, 'migration.sql'), 'utf8');
  await client.query(sql);
  console.log('Migration applied successfully');

  // Create storage bucket via Supabase Management API
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_ANON_KEY;
  const res  = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ id: 'images', name: 'images', public: true }),
  });
  const data = await res.json();
  if (res.ok || data.error === 'The resource already exists') {
    console.log('Storage bucket "images" ready');
  } else {
    console.warn('Bucket creation response:', data);
  }

  await client.end();
  console.log('Setup complete!');
}

run().catch(err => { console.error(err); process.exit(1); });
