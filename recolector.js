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
  client.subscribe('riego/surco/+/+', { qos: 0 });
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
// 🧠 NORMALIZACIÓN
// =============================
const mapaVariables = {
  temp_aire: "tempAire",
  hum_aire: "humAire",
  hum_tierra: "humTierra"
};

// =============================
// 🧠 CONTROL DUPLICADOS MQTT
// =============================
let ultimoRegistro = {};

// =============================
// 🚨 CONTROL ANTI-LOOP
// =============================
let bloqueando = false;

// =============================
// 🧠 CONTROL HISTORIAL
// =============================
const MAX_HISTORIAL = 100;
let ultimoCambio = {};
let ultimoHistorial = {};

// =============================
// 📡 MQTT → FIREBASE
// =============================
client.on('message', async (topic, message) => {

  try {
    bloqueando = true;

    let valor = message.toString();
    const [, , surcoId, variable] = topic.split('/');
    const id = parseInt(surcoId);

    // 🔒 protección
    if (!id || isNaN(id)) return;
    if (!VARIABLES_VALIDAS.includes(variable)) return;

    const variableNormalizada = mapaVariables[variable] || variable;

    // 🔁 evitar duplicados exactos MQTT
    const clave = `${id}_${variableNormalizada}`;
    if (ultimoRegistro[clave] === valor) return;
    ultimoRegistro[clave] = valor;

    // =========================
    // 🌡️ SENSORES
    // =========================
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {
      await db.ref(`surcos/${id}/sensores/${variableNormalizada}`).set(valor);
    }

    // =========================
    // 🎮 MODO
    // =========================
    if (variable === "modo") {
      await db.ref(`surcos/${id}/modo`).set(valor);
    }

    // =========================
    // 💧 VÁLVULA → RIEGO
    // =========================
    if (variable === "valvula") {
      await db.ref(`surcos/${id}/riego`).set(valor === "ON");
    }

    // =========================
    // ⚙️ UMBRALES
    // =========================
    if (variable === "umbrales") {
      try {
        const data = JSON.parse(valor);
        await db.ref(`surcos/${id}/umbrales`).set(data);
      } catch (e) {}
    }

    // =========================
    // 📜 HISTORIAL INTELIGENTE
    // =========================
    if (["valvula", "modo"].includes(variable)) {

      const ahora = Date.now();
      const keyCambio = `${id}_${variable}`;

      // 🔥 debounce 2 segundos
      if (ultimoCambio[keyCambio] && ahora - ultimoCambio[keyCambio] < 2000) return;
      ultimoCambio[keyCambio] = ahora;

      // 🔥 evitar repetir mismo valor consecutivo
      const keyHistFull = `${id}_${variable}_${valor}`;
      if (ultimoHistorial[keyHistFull]) return;
      ultimoHistorial[keyHistFull] = true;

      const refHist = db.ref(`historial/${id}`);

      // 🔥 limitar tamaño
      const totalSnap = await refHist.once('value');

      if (totalSnap.exists() && totalSnap.numChildren() >= MAX_HISTORIAL) {
        const primero = Object.keys(totalSnap.val())[0];
        await refHist.child(primero).remove();
      }

      await refHist.push({
        tipo: variableNormalizada,
        valor,
        tiempo: new Date().toISOString()
      });
    }

    console.log(`📥 ${variableNormalizada} (${id}) = ${valor}`);

  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    setTimeout(() => bloqueando = false, 100);
  }

});

// =============================
// 🔁 FIREBASE → MQTT
// =============================
let estadoAnterior = {};

db.ref('surcos').on('value', snapshot => {

  if (bloqueando) return;

  const data = snapshot.val();
  if (!data) return;

  for (let id in data) {

    const actual = data[id];
    const anterior = estadoAnterior[id] || {};

    // 🎮 modo
    if (actual.modo !== anterior.modo) {
      client.publish(`riego/surco/${id}/modo`, actual.modo, { qos: 0 });
    }

    // 💧 riego → válvula
    if (actual.riego !== anterior.riego) {
      client.publish(
        `riego/surco/${id}/valvula`,
        actual.riego ? "ON" : "OFF",
        { qos: 0 }
      );
    }

    // ⚙️ umbrales
    if (JSON.stringify(actual.umbrales) !== JSON.stringify(anterior.umbrales)) {
      client.publish(
        `riego/surco/${id}/umbrales`,
        JSON.stringify(actual.umbrales),
        { qos: 0 }
      );
    }

    // 🔥 CLON REAL
    estadoAnterior[id] = JSON.parse(JSON.stringify(actual));
  }

});

// =============================
// 🌐 API
// =============================
app.get('/', (req, res) => {
  res.send('🔥 Backend MQTT ↔ Firebase PRO funcionando');
});

// =============================
// 🚀 INICIAR SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Servidor en puerto ${PORT}`);
});