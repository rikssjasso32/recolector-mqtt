const mqtt = require('mqtt');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json()); // 🔥 IMPORTANTE

// 🔥 IMPORTANTE PARA RENDER
const PORT = process.env.PORT || 3000;

// 📁 ARCHIVOS
const ARCHIVO = 'historial.json';
const ARCHIVO_CONFIG = 'config.json';

// 🔗 MQTT
const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
  console.log('🟢 MQTT conectado');
  client.subscribe('riego/surco/+/+');
});

client.on('message', (topic, message) => {
  const valor = message.toString();
  const [, , surcoId, variable] = topic.split('/');

  const registro = {
    surco: parseInt(surcoId),
    variable,
    valor,
    tiempo: new Date().toISOString()
  };

  try {
    fs.appendFileSync(ARCHIVO, JSON.stringify(registro) + '\n');
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
    if (!fs.existsSync(ARCHIVO)) {
      return res.json([]);
    }

    const contenido = fs.readFileSync(ARCHIVO, 'utf-8').trim();

    if (!contenido) return res.json([]);

    const data = contenido
      .split('\n')
      .map(line => JSON.parse(line));

    res.json(data);

  } catch (error) {
    console.error('❌ Error leyendo historial:', error);
    res.status(500).json({ error: 'Error leyendo datos' });
  }
});

// 🧹 BORRADO MANUAL
app.delete('/historial', (req, res) => {
  try {
    if (fs.existsSync(ARCHIVO)) {
      fs.writeFileSync(ARCHIVO, '');
    }
    console.log('🧹 Historial borrado manualmente');
    res.send('Historial eliminado correctamente');
  } catch (error) {
    console.error('❌ Error borrando historial:', error);
    res.status(500).send('Error al borrar historial');
  }
});


// =============================
// 🌿 API CONFIG (NUEVO 🔥)
// =============================

// 🔥 GUARDAR CONFIG
app.post('/config', (req, res) => {
  try {
    const { surco, planta, min, max, modo } = req.body;

    let data = [];

    if (fs.existsSync(ARCHIVO_CONFIG)) {
      data = JSON.parse(fs.readFileSync(ARCHIVO_CONFIG));
    }

    const index = data.findIndex(d => d.surco === surco);

    const nuevaConfig = { surco, planta, min, max };

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


// 🔥 OBTENER CONFIG
app.get('/config', (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVO_CONFIG)) {
      return res.json([]);
    }

    const data = JSON.parse(fs.readFileSync(ARCHIVO_CONFIG));
    res.json(data);

  } catch (error) {
    console.error("❌ Error leyendo config:", error);
    res.status(500).json([]);
  }
});


// =============================
// 🧠 LIMPIEZA AUTOMÁTICA (HISTORIAL)
// =============================
function limpiarHistorialSemanal() {
  const hoy = new Date();
  const dia = hoy.getDay(); // 1 = lunes

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

// 🔁 Revisar cada 10 minutos
setInterval(limpiarHistorialSemanal, 1000 * 60 * 10);

// 🔥 Ejecutar al iniciar servidor
limpiarHistorialSemanal();


// =============================
// 🚀 SERVIDOR
// =============================
app.listen(PORT, () => {
  console.log(`🌐 Servidor corriendo en puerto ${PORT}`);
});