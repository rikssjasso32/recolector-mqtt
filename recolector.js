const mqtt = require('mqtt');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// 🔥 IMPORTANTE PARA RENDER
const PORT = process.env.PORT || 3000;

const ARCHIVO = 'historial.json';

// 🔗 MQTT
const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
  console.log('🟢 MQTT conectado');
  client.subscribe('riego/surco/+/+');
});

client.on('message', (topic, message) => {
  const valor = message.toString();
  const [, , surcoId, variable] = topic.split('/');

  const registro = {
    surco: parseInt(surcoId),
    variable,
    valor,
    tiempo: new Date().toISOString()
  };

  fs.appendFileSync(ARCHIVO, JSON.stringify(registro) + '\n');

  console.log('📥 Guardado:', registro);
});

// 🌐 API
app.get('/historial', (req, res) => {

  if (!fs.existsSync(ARCHIVO)) {
    return res.json([]);
  }

  const data = fs.readFileSync(ARCHIVO, 'utf-8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));

  res.json(data);
});

// 🔥 IMPORTANTE
app.listen(PORT, () => {
  console.log(`🌐 Servidor corriendo en puerto ${PORT}`);
});