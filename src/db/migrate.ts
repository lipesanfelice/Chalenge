import { banco } from '../infrastructure/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') throw Error('Use: migration:up ou migration:down');
await banco.initialize();
try {
  const path = join(process.cwd(), 'src', 'db', 'migrations', direction === 'up' ? '001.sql' : '001.down.sql');
  await banco.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY)');
  const [found] = await banco.query('SELECT version FROM schema_migrations WHERE version=$1', ['001']);
  if (direction === 'up' && !found) {
    await banco.transaction(async manager => {
      await manager.query(readFileSync(path,'utf8'));
      await manager.query('INSERT INTO schema_migrations(version) VALUES ($1)', ['001']);
    });
  } else if (direction === 'down' && found) {
    await banco.transaction(async manager => {
      await manager.query(readFileSync(path,'utf8'));
      await manager.query('DELETE FROM schema_migrations WHERE version=$1', ['001']);
    });
  }
  console.log(`Migration ${direction} concluída`);
} finally { await banco.destroy(); }
