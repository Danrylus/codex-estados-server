const express = require('express');
const mysql = require('mysql');
const jwt = require('jsonwebtoken');
const hasher = require('wordpress-hash-node');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = 8760;

app.use(bodyParser.json({ limit: '50mb' }))
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.use(cors());
// Configurar la conexión a la base de datos
let dbConfig;

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

console.log(process.env.NODE_ENV);

if (process.env.NODE_ENV === 'development') {
  // Configuración para entorno de desarrollo
  dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'codex_txt'
  };
} else {
  // Configuración para otros entornos (por ejemplo, producción)
  dbConfig = {
    host: 'localhost',
    user: 'asesunnr_cdx',
    password: 'p49)iXS17@',
    database: 'asesunnr_cdx'
  };
}

const db = mysql.createConnection(dbConfig);

db.connect(err => {
  if (err) {
    throw err;
  }
  console.log('Conexión a la base de datos establecida');
});

app.get('/', (req, res) => {
  res.send('Servidor en línea');
});

// ************* Endpoint para el inicio de sesión************* //

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Verificar si el usuario existe en la base de datos
  db.query('SELECT * FROM cdx_users WHERE user_login = ?', [username], async (error, results) => {

    if (error) { // Caso en el que no se pueda conectar con la base de datos
      res.status(500).send('Error en el servidor');
    } else if (results.length === 0) { // Caso en el que no se encuentra un usuario con ese nombre
      res.status(401).send('Usuario no encontrado');
    } else { // Caso en el que sí se encuentra un usuario con ese nombre
      const user = results[0];
      let isPasswordCorrect;

      // Chequeo de la contraseña
      if (process.env.NODE_ENV === 'development') {
        isPasswordCorrect = (password === user.user_pass);
      } else {
        isPasswordCorrect = hasher.CheckPassword(password, user.user_pass);
      }

      if (isPasswordCorrect) {
        // Contraseña correcta, realizar la consulta adicional a cdx_usermeta para obtener el nivel de usuario
        db.query('SELECT meta_value FROM cdx_usermeta WHERE user_id = ? AND meta_key = ?', [user.ID, 'cdx_user_level'], async (error, metaResults) => {
          if (error) {
            res.status(500).send('Error en el servidor');
          } else {
            const userLevel = metaResults.length > 0 ? metaResults[0].meta_value : null;

            // Verificar la suscripción del usuario en cdx_pms_member_subscriptions
            db.query('SELECT * FROM cdx_pms_member_subscriptions WHERE user_id = ?', [user.ID], async (error, subscriptionResults) => {
              if (error) {
                res.status(500).send('Error en el servidor');
              } else {
                const validPlans = [3865, 601, 18568]; // IDs de planes de suscripción válidos para usar la plataforma
                let hasValidSubscription = false;
                let expirationDate = null;

                // Verificación de que la suscripción actual del usuario no esté expirada
                for (const subscription of subscriptionResults) {
                  if (validPlans.includes(subscription.subscription_plan_id) && subscription.status === 'active') {
                    hasValidSubscription = true;
                    // Almacenamiento de la fecha de expiración de la suscripción
                    expirationDate = subscription.expiration_date;
                    break;
                  }
                }

                // Caso en el que el usuario no cumple con los requisitos para usar la plataforma
                if (!hasValidSubscription) {
                  if (subscriptionResults.length === 0 || !validPlans.includes(subscriptionResults[0].subscription_plan_id)) {
                    res.status(403).send('Su suscripción actual de Codex no le da acceso a la plataforma.');
                  } else if (subscriptionResults[0].status !== 'active') {
                    res.status(403).send('Su suscripción ha expirado.');
                  } else {
                    res.status(403).send('No tiene una suscripción registrada en Codex.');
                  }
                } else {
                  // Generación del token JWT
                  const token = jwt.sign({
                    userId: user.ID,
                    userName: user.display_name,
                    userLevel: userLevel,
                    expirationDate: expirationDate
                  }, 'secreto_del_token');

                  res.json({ token });
                }
              }
            });
          }
        });
      } else {
        // Caso en el que la contraseña no coincida
        res.status(401).send('Contraseña incorrecta');
      }
    }
  });
});

// ************* Función para decriptar un token ************* //

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) return res.status(401).json({ message: 'No hay token proporcionado' });

  jwt.verify(token.split(' ')[1], 'secreto_del_token', (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: 'Token inválido' });
    }
    req.userId = decoded.userId;
    req.userName = decoded.userName;
    req.userLevel = decoded.userLevel;
    req.expirationDate = decoded.expirationDate;
    next();
  });
};

// ************* Endpoint para la creación de nuevos datos (CREATE) ************* //

app.post('/api/create', verifyToken, (req, res) => {
  const { yearCurrent, yearPrevious, personalData } = req.body;
  const userId = req.userId;

  // Validar que los parámetros requeridos estén presentes
  if (!yearCurrent || !yearPrevious || !personalData) {
    return res.status(400).send('Parámetros faltantes');
  }

  // Verificar el número de entradas existentes para el usuario
  const checkSql = 'SELECT COUNT(*) AS count FROM cdx_txt WHERE user_id = ?';
  db.query(checkSql, [userId], (err, results) => {
    if (err) {
      console.error('Error al verificar el número de entradas: ' + err.message);
      return res.status(500).send('Error interno del servidor');
    }

    const count = results[0].count;
    if (count >= 3) {
      return res.status(403).send('No se pueden crear más datos porque se alcanzó el límite.');
    }

    // Serializar los nuevos datos a formato JSON
    const personalDataSerialized = JSON.stringify(personalData);
    const downloadsSerialized = JSON.stringify({
      situacion: 0,
      resultados: 0,
      patrimonio: 0,
      efectivo: 0
    });

    // Construir y ejecutar la consulta SQL
    const insertSql = 'INSERT INTO cdx_txt (user_id, yearCurrent, yearPrevious, personalData, downloads) VALUES (?, ?, ?, ?, ?)';
    db.query(insertSql, [userId, yearCurrent, yearPrevious, personalDataSerialized, downloadsSerialized], (err, result) => {
      if (err) {
        console.error('Error al crear datos: ' + err.message);
        return res.status(500).send('Error interno del servidor');
      }
      res.status(201).send('Datos creados correctamente');
    });
  });
});


// ************* Endpoint para el retorno de la data de un usuario (READ) ************* //

app.get('/api/data', verifyToken, (req, res) => {
  const userId = req.userId;
  const dataId = req.query.dataId;

  if (!dataId) {
    return res.status(400).json({ error: 'Parámetro dataId faltante' });
  }

  const sql = 'SELECT * FROM cdx_txt WHERE user_id = ? AND ID = ?';
  db.query(sql, [userId, dataId], (err, result) => {
    if (err) {
      return res.status(500).json({ error: 'Error interno del servidor' });
    }

    if (result.length === 0) {
      return res.status(404).json({ error: 'Datos no encontrados' });
    }

    const expirationDate = new Date(req.expirationDate);
    const currentDate = new Date();

    if (expirationDate < currentDate) {
      return res.status(403).json({ valid: false, message: 'Su suscripción ha expirado.' });
    }

    const userRow = result[0];

    res.json({ userRow });
  });
});

// ************* Endpoint para obtener todos los resultados de un usuario ************* //

app.get('/api/all-data', verifyToken, (req, res) => {
  const userId = req.userId;
  const userName = req.userName;
  const userLevel = req.userLevel;

  const expirationDate = new Date(req.expirationDate);
  const currentDate = new Date();

  if (expirationDate < currentDate) {
    return res.status(403).json({ valid: false, message: 'Su suscripción ha expirado.' });
  }

  const sql = 'SELECT ID, yearCurrent, personalData FROM cdx_txt WHERE user_id = ?';
  db.query(sql, [userId], (err, results) => {
    if (err) {
      console.error('Error al obtener datos: ' + err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }

    res.json({ userId, userName, userLevel, data: results });
  });
});


// ************* Endpoint para la actualización (UPDATE) ************* //

app.put('/api/update', (req, res) => {
  const { data, dataName, userId, dataId } = req.body;

  // Validar que los parámetros requeridos estén presentes
  if (!data || !dataName || !userId || !dataId) {
    return res.status(400).send('Parámetros faltantes');
  }

  // Esto es importante para prevenir ataques de inyección de SQL
  const allowedFields = ['originalData', 'ciasData', 'sriData', 'selecciones', 'saldoECP', 'saldoEFE', 'saldoEFEDirecto', 'personalData', 'downloads', 'rawMapping', 'cuentasASeleccionar'];
  if (!allowedFields.includes(dataName)) {
    return res.status(400).send('Nombre de campo no válido');
  }

  // Serializar los nuevos datos a formato JSON
  const newDataSerializada = JSON.stringify(data);

  // Construir y ejecutar la consulta SQL
  const sql = `UPDATE cdx_txt SET ${dataName} = ? WHERE user_id = ? AND ID = ?`;
  db.query(sql, [newDataSerializada, userId, dataId], (err, result) => {
    if (err) {
      return res.status(500).send('Error interno del servidor');
    }
    // Verificar si se actualizó alguna fila
    if (result.affectedRows === 0) {
      return res.status(404).send('Datos no encontrados');
    }
    res.send('Datos actualizados correctamente');
  });
});

// ************* Endpoint para la actualización de una empresa (UPDATE) ************* //

app.put('/api/update-company', verifyToken, (req, res) => {
  const { dataId, yearCurrent, yearPrevious, personalData} = req.body;
  const userId = req.userId;

  if (!yearCurrent || !yearPrevious || !personalData) {
    return res.status(400).send('Parámetros faltantes');
  }
  const updateSql = 'UPDATE cdx_txt SET yearCurrent = ?, yearPrevious = ?, personalData = ? WHERE user_id = ?  AND ID = ?';
  const personalDataSerialized = JSON.stringify(personalData);
  db.query(updateSql, [yearCurrent, yearPrevious, personalDataSerialized, userId, dataId], (err, result) => {
    if (err) {
      console.error('Error al actualizar datos: ' + err.message);
      return res.status(500).send('Error interno del servidor');
    }
    res.status(200).send('Datos actualizados correctamente');
  });
});

// ************* Endpoint para seleccionar todas las empresas que requieran cambio de activos ************* //

// Nota: verificar el userLevel para permitir esta operación

app.get('/api/get-requests', verifyToken, (req, res) => {

  const sql = 'SELECT ID, personalData, requestChange FROM cdx_txt WHERE requestChange IS NOT NULL AND requestApproved IS NOT TRUE';

  db.query(sql, (err, results) => {
    if (err) {
      console.error('Error al obtener datos: ' + err.message);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }

    res.json({ data: results });
  });
});

// ************* Endpoint para que el usuario solicite un cambio ************* //

app.post('/api/send-request', verifyToken, (req, res) => {
  const { dataId, requestChange } = req.body;
  const userId = req.userId;

  if (!requestChange || !dataId) {
    return res.status(400).send('Parámetros faltantes');
  }

  const updateSql = 'UPDATE cdx_txt SET requestChange = ?, requestApproved = ? WHERE user_id = ?  AND ID = ?';

  db.query(updateSql, [requestChange, null, userId, dataId], (err, result) => {
    if (err) {
      console.error('Error al actualizar datos: ' + err.message);
      return res.status(500).send('Error interno del servidor');
    }
    res.status(200).send('Solicitud ingresada correctamente');
  });
});

// ************* Endpoint para que un administrador acepte o rechace un cambio a un usuario ************* //

app.put('/api/check-request', verifyToken, (req, res) => {

  // Nota: verificar el token para revisar el userLevel antes de realizar la operación

  const { dataId, approvalStatus, personalData } = req.body;

  if (!dataId || !personalData) {
    return res.status(400).send('Parámetros faltantes');
  }

  const updateSql = 'UPDATE cdx_txt SET personalData = ?, requestChange = ?, requestApproved = ? WHERE ID = ?';

  const personalDataSerialized = JSON.stringify(personalData)

  db.query(updateSql, [personalDataSerialized, null, approvalStatus, dataId], (err, result) => {
    if (err) {
      console.error('Error al actualizar datos: ' + err.message);
      return res.status(500).send('Error interno del servidor');
    }
    res.status(200).send('Solicitud ingresada correctamente');
  });
});


// ************* Puerto ************* //

app.listen(8760, () => {
  console.log(`Servidor Express corriendo en el puerto ${PORT}`);
});
