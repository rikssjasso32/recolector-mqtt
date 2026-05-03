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
const client = mqtt.connect('mqtt://broker.hivemq.com', {
  reconnectPeriod: 3000,
  keepalive: 60
});

client.on('connect', () => {
  console.log('🟢 MQTT conectado');
  client.subscribe('riego/surco/+/+');
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
let ultimoEnvio = {};

// =============================
// 📡 MQTT → FIREBASE
// =============================
client.on('message', async (topic, message) => {

  try {

    const valor = message.toString();
    const [, , surcoId, variable] = topic.split('/');
    const id = parseInt(surcoId);

    if (!VARIABLES_VALIDAS.includes(variable)) return;

    const variableNormalizada = mapaVariables[variable] || variable;

    const clave = `${id}_${variableNormalizada}`;

    if (
      variable !== "hum_tierra" &&
      ultimoRegistro[clave] === valor
    ) return;

    ultimoRegistro[clave] = valor;

    const ahora = Date.now();

    if (
      variable !== "hum_tierra" &&
      ultimoEnvio[clave] &&
      ahora - ultimoEnvio[clave] < 2000
    ) return;

    ultimoEnvio[clave] = ahora;

    // =========================
    // 🌡️ SENSORES
    // =========================
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {

      await db.ref(`surcos/${id}/sensores/${variableNormalizada}`).set(valor);

      if (variable === "hum_tierra") {
        const snap = await db.ref(`surcos/${id}`).once('value');
        await evaluarAutomaticoBackend(id, snap.val());
      }
    }

    // =========================
    // 🎮 MODO
    // =========================
    if (variable === "modo") {
      await db.ref(`surcos/${id}/modo`).set(valor);
    }

    // =========================
    // 💧 VÁLVULA
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
      } catch {}
    }

    // =========================
    // 📜 HISTORIAL CORRECTO
    // =========================
    if (variable === "valvula") {

      const snap = await db.ref(`surcos/${id}/modo`).once('value');
      const modoActual = snap.val() || "MANUAL";

      const tiempo = new Date().toISOString();

      await db.ref(`historial/${id}`).push({
        variable: "modo",
        valor: modoActual,
        tiempo
      });

      await db.ref(`historial/${id}`).push({
        variable: "valvula",
        valor,
        tiempo
      });

    } else if (variable === "modo") {

      await db.ref(`historial/${id}`).push({
        variable: "modo",
        valor,
        tiempo: new Date().toISOString()
      });

    }

  } catch (err) {
    console.error("❌ Error:", err);
  }

}); // 🔥 CIERRE CORRECTO

// =============================
// 🔁 FIREBASE → MQTT
// =============================
let estadoAnterior = {};
let inicializado = false;

db.ref('surcos').on('value', snapshot => {

  const data = snapshot.val();
  if (!data) return;

  if (!inicializado) {
    estadoAnterior = JSON.parse(JSON.stringify(data));
    inicializado = true;
    return;
  }

  for (let id in data) {

    const actual = data[id] || {};
    const anterior = estadoAnterior[id] || {};

    if (actual.modo !== anterior.modo) {
      client.publish(`riego/surco/${id}/modo`, actual.modo || "MANUAL");
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

});

// =============================
// 🫀 KEEP ALIVE
// =============================
setInterval(() => {
  console.log("🫀 Backend vivo:", new Date().toLocaleTimeString());
}, 10000);

// =============================
// 🌐 API
// =============================
app.get('/', (req, res) => {
  res.send('🔥 Backend funcionando');
});

// =============================
// 🚀 SERVER
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Servidor en puerto ${PORT}`);
});

// =============================
// 🌱 AUTOMÁTICO
// =============================
async function evaluarAutomaticoBackend(id, e){

  if (!e || e.modo !== "AUTOMATICO") return;

  const humedad = parseFloat(e.sensores?.humTierra);
  if (isNaN(humedad)) return;

  const u = e.umbrales;
  if (!u) return;

  const min = Number(u.humTierraMin);
  const max = Number(u.humTierraMax);

  let estado = e.riego ? "ON" : "OFF";
  let nuevo = estado;

  if (estado === "OFF" && humedad < min) nuevo = "ON";
  if (estado === "ON" && humedad > max) nuevo = "OFF";

  if (nuevo !== estado) {

    client.publish(`riego/surco/${id}/valvula`, nuevo);

    await db.ref(`surcos/${id}/riego`)
      .set(nuevo === "ON");
  }
}