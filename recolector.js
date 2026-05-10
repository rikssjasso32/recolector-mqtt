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

    const variableNormalizada =
      mapaVariables[variable] || variable;

    // =========================
    // 🔁 EVITAR DUPLICADOS
    // =========================
    const clave = `${id}_${variableNormalizada}`;

    if (
      variable !== "hum_tierra" &&
      ultimoRegistro[clave] === valor
    ){
      return;
    }

    ultimoRegistro[clave] = valor;

    // =========================
    // ⏱️ THROTTLE
    // =========================
    const ahora = Date.now();

    if (
      variable !== "hum_tierra" &&
      ultimoEnvio[clave] &&
      ahora - ultimoEnvio[clave] < 2000
    ){
      return;
    }

    ultimoEnvio[clave] = ahora;

    // =========================
    // 🌡️ SENSORES
    // =========================
    if ([
      "temp_aire",
      "hum_aire",
      "hum_tierra"
    ].includes(variable)) {

      await db.ref(
        `surcos/${id}/sensores/${variableNormalizada}`
      ).set(valor);

      // 🔥 automático
      if(variable === "hum_tierra"){

        const snapshot =
          await db.ref(`surcos/${id}`).once('value');

        const estado = snapshot.val();

        await evaluarAutomaticoBackend(id, estado);
      }
    }

    // =========================
    // 🎮 MODO
    // =========================
    if(variable === "modo"){

      await db.ref(`surcos/${id}/modo`)
        .set(valor);
    }

    // =========================
    // 💧 VÁLVULA
    // =========================
    if(variable === "valvula"){

      await db.ref(`surcos/${id}/riego`)
        .set(valor === "ON");
    }

    // =========================
    // ⚙️ UMBRALES
    // =========================
    if(variable === "umbrales"){

      try{

        const data = JSON.parse(valor);

        await db.ref(`surcos/${id}/umbrales`)
          .set(data);

      }catch(e){}
    }

    // =========================
    // 📜 HISTORIAL
    // =========================
    await db.ref(`historial/${id}`).push({

      variable: variable,
      valor: valor,

      tiempo: new Date().toISOString()

    });

    console.log(
      `📥 ${variableNormalizada} (${id}) = ${valor}`
    );

  } catch(err){

    console.error("❌ Error:", err);
  }

});

// =============================
// 🔁 FIREBASE → MQTT
// =============================
let estadoAnterior = {};

db.ref('surcos').on('value', async snapshot => {

  const data = snapshot.val();

  if (!data) return;

  for (let id in data) {

    const actual = data[id];

    const anterior = estadoAnterior[id] || {};

    // 🎮 modo
    if(actual.modo !== anterior.modo){

      client.publish(
        `riego/surco/${id}/modo`,
        actual.modo
      );
    }

    // 💧 válvula
    if(actual.riego !== anterior.riego){

      client.publish(
        `riego/surco/${id}/valvula`,
        actual.riego ? "ON" : "OFF"
      );
    }

    // ⚙️ umbrales
    const uA = actual.umbrales || {};
    const uB = anterior.umbrales || {};

    if(
      uA.humTierraMin !== uB.humTierraMin ||
      uA.humTierraMax !== uB.humTierraMax
    ){

      client.publish(
        `riego/surco/${id}/umbrales`,
        JSON.stringify({
          humTierraMin: Number(uA.humTierraMin) || 0,
          humTierraMax: Number(uA.humTierraMax) || 0
        })
      );
    }

    estadoAnterior[id] =
      JSON.parse(JSON.stringify(actual));
  }

});

// =============================
// 🌱 AUTOMÁTICO BACKEND
// =============================
async function evaluarAutomaticoBackend(id, e){

  if (!e) return;

  if (e.modo !== "AUTOMATICO") return;

  const humedad =
    parseFloat(e.sensores?.humTierra);

  if (isNaN(humedad)) return;

  const u = e.umbrales;

  if (!u) return;

  const min = Number(u.humTierraMin) || 0;
  const max = Number(u.humTierraMax) || 0;

  if (min === 0 && max === 0) return;

  if (min >= max) return;

  const estadoActual =
    e.riego ? "ON" : "OFF";

  let nuevoEstado = estadoActual;

  if (
    estadoActual === "OFF" &&
    humedad < min
  ){
    nuevoEstado = "ON";
  }

  if (
    estadoActual === "ON" &&
    humedad > max
  ){
    nuevoEstado = "OFF";
  }

  if(nuevoEstado !== estadoActual){

    console.log(
      `🌱 AUTO ${id}: ${estadoActual} → ${nuevoEstado}`
    );

    client.publish(
      `riego/surco/${id}/valvula`,
      nuevoEstado
    );

    await db.ref(`surcos/${id}/riego`)
      .set(nuevoEstado === "ON");
  }
}

// =============================
// 📜 API HISTORIAL
// =============================
app.get('/historial', async (req, res) => {

  try{

    const snapshot =
      await db.ref('historial').once('value');

    const data = snapshot.val() || {};

    let resultado = [];

    Object.keys(data).forEach(surco => {

      const registros = data[surco];

      Object.keys(registros).forEach(key => {

        resultado.push({
          surco,
          ...registros[key]
        });

      });

    });

    resultado.sort((a,b) =>
      new Date(a.tiempo) - new Date(b.tiempo)
    );

    res.json(resultado);

  }catch(err){

    console.error(err);

    res.status(500).json({
      error: "Error obteniendo historial"
    });
  }

});

// =============================
// 🌐 API
// =============================
app.get('/', (req, res) => {

  res.send('🔥 Backend funcionando');

});

// =============================
// 🚀 INICIAR SERVIDOR
// =============================
app.listen(PORT, () => {

  console.log(`🌐 Servidor en puerto ${PORT}`);

});

// =============================
// 🫀 KEEP ALIVE
// =============================
setInterval(() => {

  console.log(
    "🫀 Backend vivo:",
    new Date().toLocaleTimeString()
  );

}, 10000);