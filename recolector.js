const mqtt = require('mqtt');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const app = express();

console.log("🚀 Iniciando servidor...");
console.log("🌱 ENV SURCO_ID:", process.env.SURCO_ID);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

// 🔥 ID DEL CUADRANTE (CAMBIAR EN CADA SERVER)
const SURCO_ID = parseInt(process.env.SURCO_ID);

if (!SURCO_ID) {
  console.error("❌ ERROR: SURCO_ID no definido");
  process.exit(1);
}

// 📁 Archivos por cuadrante
const ARCHIVO = `historial_${SURCO_ID}.json`;
const ARCHIVO_CONFIG = `config_${SURCO_ID}.json`;
const ARCHIVO_LIMPIEZA = `ultima_limpieza_${SURCO_ID}.txt`;

// 🔗 MQTT
const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
  console.log(`🟢 MQTT conectado (Surco ${SURCO_ID})`);
  client.subscribe('riego/surco/+/+');
});

// =============================
// 🔒 VARIABLES PERMITIDAS
// =============================
const VARIABLES_VALIDAS = [
  "temp_aire",
  "hum_aire",
  "hum_tierra",
  "valvula"
];

// =============================
// 🧠 CONTROL INTELIGENTE
// =============================
let ultimoRegistro = {};
let ultimoTiempo = {};
const INTERVALO_MIN = 2000;

client.on('message', (topic, message) => {

  const valor = message.toString();
  const [, , surcoId, variable] = topic.split('/');

  const id = parseInt(surcoId);

  // 🔥 FILTRO CLAVE (SOLO ESTE CUADRANTE)
  if (id !== SURCO_ID) return;

  if (!VARIABLES_VALIDAS.includes(variable)) return;
  if (!valor || valor.trim() === "") return;

  const clave = `${id}_${variable}`;
  const ahora = Date.now();

  if (ultimoRegistro[clave] === valor) return;
  if (ultimoTiempo[clave] && (ahora - ultimoTiempo[clave] < INTERVALO_MIN)) return;

  ultimoRegistro[clave] = valor;
  ultimoTiempo[clave] = ahora;

  const registro = {
    surco: id,
    variable,
    valor,
    tiempo: new Date().toISOString()
  };

  try {
    fs.appendFileSync(ARCHIVO, JSON.stringify(registro) + '\n');
    recortarHistorial();
    console.log(`📥 [Surco ${SURCO_ID}]`, registro);
  } catch (error) {
    console.error('❌ Error guardando:', error);
  }
});

// =============================
// 🌐 API HISTORIAL
// =============================
app.get('/historial', (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVO)) return res.json([]);

    const contenido = fs.readFileSync(ARCHIVO, 'utf-8').trim();
    if (!contenido) return res.json([]);

    const data = contenido
      .split('\n')
      .filter(line => line.trim() !== "")
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);

    res.json(data);

  } catch (error) {
    console.error('❌ Error leyendo historial:', error);
    res.status(500).json([]);
  }
});

app.delete('/historial', (req, res) => {
  try {
    if (fs.existsSync(ARCHIVO)) fs.writeFileSync(ARCHIVO, '');
    console.log(`🧹 Historial borrado (Surco ${SURCO_ID})`);
    res.send("OK");
  } catch (error) {
    res.status(500).send("Error");
  }
});

// =============================
// 🌿 API CONFIG
// =============================
app.post('/config', (req, res) => {
  try {
    const { surco, planta, min, max, modo, plantas } = req.body;

    // 🔥 SEGURIDAD
    if (surco !== SURCO_ID) {
      return res.status(403).send("Surco incorrecto");
    }

    const nuevaConfig = {
      surco,
      planta,
      min,
      max,
      modo,
      plantas: plantas || []
    };

    fs.writeFileSync(ARCHIVO_CONFIG, JSON.stringify([nuevaConfig], null, 2));

    console.log(`💾 Config guardada (Surco ${SURCO_ID})`, nuevaConfig);
    res.send("OK");

  } catch (error) {
    console.error("❌ Error config:", error);
    res.status(500).send("Error");
  }
});

app.get('/config', (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVO_CONFIG)) return res.json([]);

    const data = JSON.parse(fs.readFileSync(ARCHIVO_CONFIG));

    res.json(data.map(cfg => ({
      ...cfg,
      plantas: cfg.plantas || []
    })));

  } catch (error) {
    res.status(500).json([]);
  }
});

// =============================
// 🧹 LIMPIEZA AUTOMÁTICA
// =============================
function limpiarHistorialSemanal() {

  let ultima = "";

  if (fs.existsSync(ARCHIVO_LIMPIEZA)) {
    ultima = fs.readFileSync(ARCHIVO_LIMPIEZA, 'utf-8');
  }

  if (ultima) {
    const dias = Math.floor(
      (new Date() - new Date(ultima)) / (1000 * 60 * 60 * 24)
    );
    if (dias < 7) return;
  }

  if (fs.existsSync(ARCHIVO)) {
    fs.writeFileSync(ARCHIVO, '');
    console.log(`🧹 Limpieza automática (Surco ${SURCO_ID})`);
  }

  fs.writeFileSync(ARCHIVO_LIMPIEZA, new Date().toISOString());
}

setInterval(limpiarHistorialSemanal, 1000 * 60 * 10);
limpiarHistorialSemanal();

// =============================
// ✂️ RECORTE
// =============================
function recortarHistorial() {
  if (!fs.existsSync(ARCHIVO)) return;

  const lineas = fs.readFileSync(ARCHIVO, 'utf-8')
    .split('\n')
    .filter(l => l.trim() !== "");

  const MAX = 1000;

  if (lineas.length > MAX) {
    const nuevas = lineas.slice(-MAX);
    fs.writeFileSync(ARCHIVO, nuevas.join('\n') + '\n');
  }
}

// =============================
// 🚀 SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Server Surco ${SURCO_ID} en puerto ${PORT}`);
});