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
// 🚀 SERVIDOR
// =============================
const app = express();
app.use(cors());
app.use(express.json());

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
// 🧠 CONTROL DUPLICADOS
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

    const clave = `${id}_${variable}`;
    if (ultimoRegistro[clave] === valor) return;
    ultimoRegistro[clave] = valor;

    // =========================
    // 🔥 SEPARAR SENSORES Y ESTADOS
    // =========================

    // 🌡️ Sensores
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {
      await db.ref(`surcos/${id}/sensores/${variable}`).set(valor);
    }

    // 🎮 Modo
    if (variable === "modo") {
      await db.ref(`surcos/${id}/modo`).set(valor);
    }

    // 💧 Válvula → riego booleano
    if (variable === "valvula") {
      await db.ref(`surcos/${id}/riego`).set(valor === "ON");
    }

    // ⚙️ Umbrales
    if (variable === "umbrales") {
      try {
        const data = JSON.parse(valor);
        await db.ref(`surcos/${id}/umbrales`).set(data);
      } catch (e) {}
    }

    // =========================
    // 🔥 HISTORIAL
    // =========================
    await db.ref(`historial/${id}`).push({
      tipo: variable,
      valor,
      tiempo: new Date().toISOString()
    });

    console.log(`📥 ${variable} (${id}) = ${valor}`);

  } catch (err) {
    console.error("❌ Error:", err);
  }

});

// =============================
// 🔁 FIREBASE → MQTT
// =============================
let estadoAnterior = {};

db.ref('surcos').on('value', snapshot => {

  const data = snapshot.val();
  if (!data) return;

  for (let id in data) {

    const actual = data[id];
    const anterior = estadoAnterior[id] || {};

    // 🎮 modo
    if (actual.modo !== anterior.modo) {
      client.publish(`riego/surco/${id}/modo`, actual.modo, { qos: 1 });
    }

    // 💧 riego → válvula
    if (actual.riego !== anterior.riego) {
      client.publish(
        `riego/surco/${id}/valvula`,
        actual.riego ? "ON" : "OFF",
        { qos: 1 }
      );
    }

    // ⚙️ umbrales
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
  console.log(`🌐 Servidor en puerto ${PORT}`);
});