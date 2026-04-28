import app from './app.js';

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`graphtask running on 127.0.0.1:${PORT}`);
});
