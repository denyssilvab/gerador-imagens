require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs'), path = require('path');

async function run(file) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
  await client.query(sql);
  console.log(`✅ ${file} applied`);
  await client.end();
}

run(process.argv[2] || 'migration_auth.sql').catch(e => { console.error(e); process.exit(1); });
