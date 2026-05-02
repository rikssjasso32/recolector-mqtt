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

let procesandoAuto = false;

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

db.ref('surcos').on('value', async snapshot => {

  if (bloqueando || procesandoAuto) return;

  const data = snapshot.val();
  if (!data) return;

  procesandoAuto = true;

  for (let id in data) {

    const actual = data[id];
    const anterior = estadoAnterior[id] || {};

    await evaluarAutomaticoBackend(id, actual);

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

    if (
      uA.humTierraMin !== uB.humTierraMin ||
      uA.humTierraMax !== uB.humTierraMax
    ) {
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

  procesandoAuto = false;

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

async function evaluarAutomaticoBackend(id, e){

  if (!e) return;
  if (e.modo !== "AUTOMATICO") return;

  const humedad = parseFloat(e.sensores?.humTierra);
  if (isNaN(humedad)) return;

  const u = e.umbrales;
  if (!u) return;

  const min = Number(u.humTierraMin) || 0;
  const max = Number(u.humTierraMax) || 0;

  if (min === 0 && max === 0) return;
  if (min >= max) return;

  const estadoActual = e.riego ? "ON" : "OFF";
  let nuevoEstado = estadoActual;

  if (estadoActual === "OFF" && humedad < min) {
    nuevoEstado = "ON";
  }

  if (estadoActual === "ON" && humedad > max) {
    nuevoEstado = "OFF";
  }

  if (nuevoEstado !== estadoActual) {

    console.log(`🌱 BACKEND AUTO ${id}: ${estadoActual} → ${nuevoEstado}`);

    client.publish(`riego/surco/${id}/valvula`, nuevoEstado);

    await db.ref(`surcos/${id}/riego`)
      .set(nuevoEstado === "ON");
  }
}