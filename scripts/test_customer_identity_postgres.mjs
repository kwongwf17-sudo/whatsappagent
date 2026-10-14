import { spawnSync } from 'node:child_process';
const url=new URL(process.env.CUSTOMER_IDENTITY_TEST_DATABASE_URL || process.env.DATABASE_URL || process.env.WHATSAPP_POSTGRES_URL);
if(process.env.POSTGRES_PROXY_HOST) {
 url.hostname=process.env.POSTGRES_PROXY_HOST;
 url.port=process.env.POSTGRES_PROXY_PORT || url.port;
}
url.searchParams.set('sslmode','disable');
const result=spawnSync(process.execPath,['--test','lib/customer_identity_postgres.test.mjs'],{
 stdio:'inherit',env:{...process.env,CUSTOMER_IDENTITY_TEST_DATABASE_URL:url.toString()},
});
process.exitCode=result.status ?? 1;
