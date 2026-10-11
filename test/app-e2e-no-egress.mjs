// Containment supplements the executor's internal Docker network.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
if (process.env.MC_NO_EGRESS !== '1') throw new Error('AppE2E no-egress scope absent');
const deny = () => {
  throw new Error('AppE2E external HTTP refused');
};
globalThis.fetch = async () => {
  throw new Error('AppE2E external fetch refused');
};
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;

syncBuiltinESMExports();
