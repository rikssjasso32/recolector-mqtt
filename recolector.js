const mqtt = require('mqtt');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const ARCHIVO = 'historial.json';
const ARCHIVO_CONFIG = 'config.json';

// 🔗 MQTT
const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
  console.log('🟢 MQTT conectado');
  client.subscribe('riego/surco/+/+');
});

// =============================
// 🔒 VARIABLES PERMITIDAS (CLAVE)
// =============================
const VARIABLES_VALIDAS = [
  "temp_aire",
  "hum_aire",
  "hum_tierra",
  "valvula"
];

// =============================
// 🧠 CONTROL INTELIGENTE HISTORIAL
// =============================
let ultimoRegistro = {};
let ultimoTiempo = {};
const INTERVALO_MIN = 2000;

client.on('message', (topic, message) => {

  const valor = message.toString();
  const [, , surcoId, variable] = topic.split('/');

  // 🔥 FILTRO 1: ignorar variables no válidas
  if (!VARIABLES_VALIDAS.includes(variable)) return;

  // 🔥 FILTRO 2: ignorar mensajes vacíos (retained basura)
  if (!valor || valor.trim() === "") return;

  const clave = `${surcoId}_${variable}`;
  const ahora = Date.now();

  // 🔥 evitar duplicados
  if (ultimoRegistro[clave] === valor) return;
  if (ultimoTiempo[clave] && (ahora - ultimoTiempo[clave] < INTERVALO_MIN)) return;

  ultimoRegistro[clave] = valor;
  ultimoTiempo[clave] = ahora;

  const registro = {
    surco: parseInt(surcoId),
    variable,
    valor,
    tiempo: new Date().toISOString()
  };

  try {
    fs.appendFileSync(ARCHIVO, JSON.stringify(registro) + '\n');
    recortarHistorial();
    console.log('📥 Guardado:', registro);
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
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    res.json(data);

  } catch (error) {
    console.error('❌ Error leyendo historial:', error);
    res.status(500).json({ error: 'Error leyendo datos' });
  }
});

app.delete('/historial', (req, res) => {
  try {
    if (fs.existsSync(ARCHIVO)) fs.writeFileSync(ARCHIVO, '');
    console.log('🧹 Historial borrado manualmente');
    res.send('Historial eliminado correctamente');
  } catch (error) {
    console.error('❌ Error borrando historial:', error);
    res.status(500).send('Error al borrar historial');
  }
});

// =============================
// 🌿 API CONFIG
// =============================
app.post('/config', (req, res) => {
  try {
    const { surco, planta, min, max, modo, plantas } = req.body;

    let data = [];

    if (fs.existsSync(ARCHIVO_CONFIG)) {
      data = JSON.parse(fs.readFileSync(ARCHIVO_CONFIG));
    }

    const index = data.findIndex(d => d.surco === surco);

    const nuevaConfig = {
      surco,
      planta,
      min,
      max,
      modo,
      plantas: plantas || (index >= 0 ? data[index].plantas : []) || []
    };

    if (index >= 0) {
      data[index] = nuevaConfig;
    } else {
      data.push(nuevaConfig);
    }

    fs.writeFileSync(ARCHIVO_CONFIG, JSON.stringify(data, null, 2));

    console.log("💾 Config guardada:", nuevaConfig);
    res.send("OK");

  } catch (error) {
    console.error("❌ Error guardando config:", error);
    res.status(500).send("Error");
  }
});

app.get('/config', (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVO_CONFIG)) return res.json([]);

    const data = JSON.parse(fs.readFileSync(ARCHIVO_CONFIG));

    const dataCorregida = data.map(cfg => ({
      ...cfg,
      plantas: cfg.plantas || []
    }));

    res.json(dataCorregida);

  } catch (error) {
    console.error("❌ Error leyendo config:", error);
    res.status(500).json([]);
  }
});

// =============================
// 🧹 LIMPIEZA AUTOMÁTICA
// =============================
function limpiarHistorialSemanal() {
  const hoy = new Date();
  const dia = hoy.getDay();

  const ultimaLimpieza = global.ultimaLimpieza || "";

  if (dia === 1) {
    const hoyStr = hoy.toDateString();

    if (ultimaLimpieza !== hoyStr) {
      try {
        if (fs.existsSync(ARCHIVO)) {
          fs.writeFileSync(ARCHIVO, '');
          console.log("🧹 Historial borrado automáticamente (lunes)");
        }
        global.ultimaLimpieza = hoyStr;
      } catch (error) {
        console.error('❌ Error en limpieza automática:', error);
      }
    }
  }
}

setInterval(limpiarHistorialSemanal, 1000 * 60 * 10);
limpiarHistorialSemanal();

// =============================
// ✂️ RECORTAR HISTORIAL
// =============================
function recortarHistorial() {
  try {
    if (!fs.existsSync(ARCHIVO)) return;

    const lineas = fs.readFileSync(ARCHIVO, 'utf-8')
      .split('\n')
      .filter(l => l.trim() !== "");

    const MAX = 3000;

    if (lineas.length > MAX) {
      const nuevas = lineas.slice(-MAX);
      fs.writeFileSync(ARCHIVO, nuevas.join('\n') + '\n');
      console.log("🧹 Historial recortado");
    }

  } catch (error) {
    console.error("❌ Error recortando historial:", error);
  }
}

// =============================
// 🚀 SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Servidor corriendo en puerto ${PORT}`);
});