const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// =============================
// 🔥 FIREBASE
// =============================
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://riego-app-bb60f-default-rtdb.firebaseio.com"
});

const db = admin.database();

// =============================
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =============================
// MQTT
// =============================
const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
  console.log('🟢 MQTT conectado');
  client.subscribe('riego/surco/+/+', { qos: 1 });
});

const VARIABLES_VALIDAS = [
  "temp_aire",
  "hum_aire",
  "hum_tierra",
  "valvula",
  "modo",
  "umbrales"
];

let ultimoRegistro = {};

// =============================
// MQTT → FIREBASE
// =============================
client.on('message', async (topic, message) => {

  try {
    let valor = message.toString();
    const [, , surcoId, variable] = topic.split('/');
    const id = parseInt(surcoId);

    if (!VARIABLES_VALIDAS.includes(variable)) return;

    const clave = `${id}_${variable}`;
    if (ultimoRegistro[clave] === valor) return;
    ultimoRegistro[clave] = valor;

    await db.ref(`surcos/${id}/sensores/${variable}`).set(valor);

    await db.ref(`historial/${id}`).push({
      variable,
      valor,
      tiempo: new Date().toISOString()
    });

    console.log(`📥 ${variable} (${id}) = ${valor}`);

  } catch (err) {
    console.error("❌ Error:", err);
  }

});

// =============================
// FIREBASE → MQTT
// =============================
let estadoAnterior = {};

db.ref('surcos').on('value', snapshot => {

  const data = snapshot.val();
  if (!data) return;

  for (let id in data) {

    const actual = data[id];
    const anterior = estadoAnterior[id] || {};

    if (actual.modo !== anterior.modo) {
      client.publish(`riego/surco/${id}/modo`, actual.modo);
    }

    if (actual.riego !== anterior.riego) {
      client.publish(`riego/surco/${id}/valvula`, actual.riego ? "ON" : "OFF");
    }

    estadoAnterior[id] = actual;
  }

});

app.listen(PORT, () => {
  console.log(`🌐 Servidor en puerto ${PORT}`);
});