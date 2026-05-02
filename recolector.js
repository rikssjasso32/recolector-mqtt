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
// 🧠 NORMALIZACIÓN
// =============================
const mapaVariables = {
  temp_aire: "tempAire",
  hum_aire: "humAire",
  hum_tierra: "humTierra"
};

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

    const variableNormalizada = mapaVariables[variable] || variable;

    const clave = `${id}_${variableNormalizada}`;
    if (ultimoRegistro[clave] === valor) return;
    ultimoRegistro[clave] = valor;

    // 🌡️ sensores
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {
      await db.ref(`surcos/${id}/sensores/${variableNormalizada}`).set(valor);
    }

    // 🎮 modo
    if (variable === "modo") {
      await db.ref(`surcos/${id}/modo`).set(valor);
    }

    // 💧 válvula
    if (variable === "valvula") {
      await db.ref(`surcos/${id}/riego`).set(valor === "ON");
    }

    // ⚙️ umbrales
    if (variable === "umbrales") {
      try {
        const data = JSON.parse(valor);

        // 🔥 evitar re-escribir si es igual
        const refUmbral = db.ref(`surcos/${id}/umbrales`);
        const snap = await refUmbral.get();
        const actual = snap.val();

        if (JSON.stringify(actual) !== JSON.stringify(data)) {
          await refUmbral.set(data);
        }

      } catch (e) {}
    }

    // 📜 historial
    await db.ref(`historial/${id}`).push({
      tipo: variableNormalizada,
      valor,
      tiempo: new Date().toISOString()
    });

    console.log(`📥 ${variableNormalizada} (${id}) = ${valor}`);

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

    // 💧 válvula
    if (actual.riego !== anterior.riego) {
      client.publish(
        `riego/surco/${id}/valvula`,
        actual.riego ? "ON" : "OFF",
        { qos: 1 }
      );
    }

    // ⚙️ UMBRALES (🔥 SOLO SI CAMBIAN)
    if (
      actual.umbrales &&
      (
        actual.umbrales.humTierraMin !== anterior.umbrales?.humTierraMin ||
        actual.umbrales.humTierraMax !== anterior.umbrales?.humTierraMax
      )
    ) {

      const clave = `${id}_umbrales`;
      const valorStr = JSON.stringify(actual.umbrales);

      // 🔥 anti-spam
      if (ultimoRegistro[clave] === valorStr) continue;
      ultimoRegistro[clave] = valorStr;

      client.publish(
        `riego/surco/${id}/umbrales`,
        valorStr,
        { qos: 1 }
      );
    }

    estadoAnterior[id] = actual;
  }

});

// =============================
// 🌐 API
// =============================
app.get('/', (req, res) => {
  res.send('🔥 Backend MQTT ↔ Firebase funcionando');
});

// =============================
// 🚀 INICIAR
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Servidor en puerto ${PORT}`);
});