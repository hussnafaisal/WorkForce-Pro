// Netlify Function: runs the same Express app as server.js
const serverless = require('serverless-http');
const app = require('../../server');
const handle = serverless(app);
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await app.locals.ready; // tables created and admin seeded (once per cold start)
  let p = event.path.replace(/^\/\.netlify\/functions\/api/, '') || '/';
  if (!p.startsWith('/api') && p !== '/health') p = '/api' + p;
  event.path = p;
  return handle(event, context);
};
