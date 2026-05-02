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
// 🔗 MQTT (RECONEXIÓN SEGURA)
// =============================
const client = mqtt.connect('mqtt://broker.hivemq.com', {
  reconnectPeriod: 3000, // reconecta cada 3s
  keepalive: 60
});

client.on('connect', () => {
  console.log('🟢 MQTT conectado');
  client.subscribe('riego/surco/+/+', { qos: 0 });
});

client.on('reconnect', () => {
  console.log('🟡 Reintentando conexión MQTT...');
});

client.on('error', (err) => {
  console.error('🔴 Error MQTT:', err.message);
});

// =============================
// 🔒 VARIABLES
// =============================
const VARIABLES_VALIDAS = [
  "temp_aire",
  "hum_aire",
  "hum_tierra",
  "valvula",
  "modo",
  "umbrales"
];

const mapaVariables = {
  temp_aire: "tempAire",
  hum_aire: "humAire",
  hum_tierra: "humTierra"
};

let ultimoRegistro = {};
let ultimoEnvio = {}; // 🔥 throttle
let bloqueando = false;

// =============================
// 📡 MQTT → FIREBASE (OPTIMIZADO)
// =============================
client.on('message', async (topic, message) => {

  try {
    bloqueando = true;

    const valor = message.toString();
    const [, , surcoId, variable] = topic.split('/');
    const id = parseInt(surcoId);

    if (!VARIABLES_VALIDAS.includes(variable)) return;

    const variableNormalizada = mapaVariables[variable] || variable;

    // 🔁 evitar duplicados exactos
    const clave = `${id}_${variableNormalizada}`;
    if (ultimoRegistro[clave] === valor) return;
    ultimoRegistro[clave] = valor;

    // 🔥 THROTTLE (máx 1 cada 2 segundos)
    const ahora = Date.now();
    if (ultimoEnvio[clave] && ahora - ultimoEnvio[clave] < 2000) return;
    ultimoEnvio[clave] = ahora;

    // =========================
    // 🌡️ SENSORES
    // =========================
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {
      await db.ref(`surcos/${id}/sensores/${variableNormalizada}`)
        .set(valor)
        .catch(err => console.error("🔥 Firebase error:", err));
    }

    // =========================
    // 🎮 MODO
    // =========================
    if (variable === "modo") {
      await db.ref(`surcos/${id}/modo`)
        .set(valor)
        .catch(err => console.error("🔥 Firebase error:", err));
    }

    // =========================
    // 💧 VÁLVULA → RIEGO
    // =========================
    if (variable === "valvula") {
      await db.ref(`surcos/${id}/riego`)
        .set(valor === "ON")
        .catch(err => console.error("🔥 Firebase error:", err));
    }

    // =========================
    // ⚙️ UMBRALES
    // =========================
    if (variable === "umbrales") {
      try {
        const data = JSON.parse(valor);
        await db.ref(`surcos/${id}/umbrales`)
          .set(data)
          .catch(err => console.error("🔥 Firebase error:", err));
      } catch (e) {}
    }

    // =========================
    // 📜 HISTORIAL (CONTROLADO)
    // =========================
    if (Math.random() < 0.3) { // 🔥 solo 30% de eventos
      await db.ref(`historial/${id}`).push({
        tipo: variableNormalizada,
        valor,
        tiempo: new Date().toISOString()
      }).catch(err => console.error("🔥 Firebase error:", err));
    }

    console.log(`📥 ${variableNormalizada} (${id}) = ${valor}`);

  } catch (err) {
    console.error("❌ Error general:", err);
  } finally {
    setTimeout(() => bloqueando = false, 100);
  }

});

// =============================
// 🔁 FIREBASE → MQTT (SIN LOOP)
// =============================
let estadoAnterior = {};

db.ref('surcos').on('value', snapshot => {

  if (bloqueando) return;

  const data = snapshot.val();
  if (!data) return;

  for (let id in data) {

    const actual = data[id];
    const anterior = estadoAnterior[id] || {};

    if (actual.modo !== anterior.modo) {
      client.publish(`riego/surco/${id}/modo`, actual.modo);
    }

    if (actual.riego !== anterior.riego) {
      client.publish(
        `riego/surco/${id}/valvula`,
        actual.riego ? "ON" : "OFF"
      );
    }

  const uA = actual.umbrales || {};
  const uB = anterior.umbrales || {};

  // 🔥 comparar campo por campo (evita falsos negativos)
  if (
    uA.humTierraMin !== uB.humTierraMin ||
    uA.humTierraMax !== uB.humTierraMax
  ) {
    console.log("📤 Enviando umbrales:", uA);

    client.publish(
      `riego/surco/${id}/umbrales`,
      JSON.stringify({
        humTierraMin: Number(uA.humTierraMin) || 0,
        humTierraMax: Number(uA.humTierraMax) || 0
      })
    );
  }

    estadoAnterior[id] = JSON.parse(JSON.stringify(actual));
  }

}, (error) => {
  console.error("🔥 Firebase listener error:", error);
});

// =============================
// 🫀 KEEP ALIVE (ANTI-CRASH)
// =============================
setInterval(() => {
  console.log("🫀 Backend vivo:", new Date().toLocaleTimeString());
}, 10000);

// =============================
// 🌐 API
// =============================
app.get('/', (req, res) => {
  res.send('🔥 Backend estable PRO funcionando');
});

// =============================
// 🚀 INICIAR SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Servidor en puerto ${PORT}`);
});