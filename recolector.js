const mqtt = require('mqtt');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// 🔥 IMPORTANTE PARA RENDER
const PORT = process.env.PORT || 3000;

const ARCHIVO = 'historial.json';

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

// 🌐 API
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

// 🧠 LIMPIEZA AUTOMÁTICA (LUNES)
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

// 🚀 SERVIDOR
app.listen(PORT, () => {
  console.log(`🌐 Servidor corriendo en puerto ${PORT}`);
});