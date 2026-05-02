const mqtt = require('mqtt');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// =============================
// 🔥 FIREBASE
// =============================
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://riego-app-bb60f-default-rtdb.firebaseio.com"
});

const db = admin.database();

// =============================
// 🚀 SERVIDOR
// =============================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// =============================
// 🔗 MQTT
// =============================
const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
  console.log('🟢 MQTT conectado');
  client.subscribe('riego/surco/+/+', { qos: 1 });
});

// =============================
// 🔒 VARIABLES PERMITIDAS
// =============================
const VARIABLES_VALIDAS = [
  "temp_aire",
  "hum_aire",
  "hum_tierra",
  "valvula",
  "modo",
  "umbrales"
];

// =============================
// 🧠 CONTROL INTELIGENTE
// =============================
let ultimoRegistro = {};

// =============================
// 📡 MQTT → FIREBASE
// =============================
client.on('message', async (topic, message) => {

  try {

    let valor = message.toString();
    const [, , surcoId, variable] = topic.split('/');
    const id = parseInt(surcoId);

    if (!VARIABLES_VALIDAS.includes(variable)) return;
    if (!valor || valor.trim() === "") return;

    // 🔥 normalizar sensores
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {
      const num = parseFloat(valor);
      if (!isNaN(num)) {
        valor = Math.round(num).toString();
      }
    }

    const clave = `${id}_${variable}`;

    // 🔥 evitar duplicados
    if (ultimoRegistro[clave] === valor) return;
    ultimoRegistro[clave] = valor;

    // =========================
    // 🔥 ESTADO ACTUAL
    // =========================
    await db.ref(`surcos/${id}/sensores/${variable}`).set(valor);

    // =========================
    // 🔥 HISTORIAL
    // =========================
    await db.ref(`historial/${id}`).push({
      variable,
      valor,
      tiempo: new Date().toISOString()
    });

    console.log(`📥 ${variable} (${id}) = ${valor}`);

  } catch (error) {
    console.error('❌ Error:', error);
  }

});

// =============================
// 🔁 FIREBASE → MQTT (COMANDOS)
// =============================
let estadoAnterior = {};

db.ref('surcos').on('value', snapshot => {

  const data = snapshot.val();
  if (!data) return;

  for (let id in data) {

    const actual = data[id];
    const anterior = estadoAnterior[id] || {};

    // 🔥 modo
    if (actual.modo !== anterior.modo) {
      client.publish(`riego/surco/${id}/modo`, actual.modo, { qos: 1 });
    }

    // 🔥 válvula
    if (actual.riego !== anterior.riego) {
      client.publish(
        `riego/surco/${id}/valvula`,
        actual.riego ? "ON" : "OFF",
        { qos: 1 }
      );
    }

    // 🔥 umbrales
    if (JSON.stringify(actual.umbrales) !== JSON.stringify(anterior.umbrales)) {
      client.publish(
        `riego/surco/${id}/umbrales`,
        JSON.stringify(actual.umbrales),
        { qos: 1 }
      );
    }

    estadoAnterior[id] = actual;
  }

});

// =============================
// 🌐 API SIMPLE
// =============================
app.get('/', (req, res) => {
  res.send('🔥 Backend MQTT ↔ Firebase funcionando');
});

// =============================
// 🚀 INICIAR SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Servidor corriendo en puerto ${PORT}`);
});