const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit'); // NUEVO: Protección contra abusos
require('dotenv').config();

const app = express();

// Configuración de CORS (solo permite tus dominios)
const corsOptions = {
    origin: [
        'https://tarot-ia.netlify.app',
        'https://tarotia-app-psi.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:5500',
        'http://localhost:5500'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
    credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// ⚠️ ELIMINADO: app.use(express.static(__dirname)); 
// Ya no es necesario ni seguro, ya que tu frontend está en otra carpeta/repositorio.

// 🔒 CORRECCIÓN CRÍTICA 1: Sin fallbacks de contraseñas. Si no están en Render, el servidor se detiene.
const MONGO_URI = process.env.MONGO_URI;
const MODEL_NAME = process.env.MODEL_NAME || 'llama3-70b-8192'; // Modelo real de Groq
const API_KEY = process.env.GROQ_API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET;
const MAX_MUESTRAS_FISICAS = 5;

// Validación de seguridad al iniciar
if (!MONGO_URI || !API_KEY || !ADMIN_TOKEN || !JWT_SECRET) {
    console.error("❌ ERROR CRÍTICO: Faltan variables de entorno (MONGO_URI, GROQ_API_KEY, ADMIN_TOKEN, JWT_SECRET). Revisa Render.com");
    process.exit(1); // Detiene el servidor para no operar de forma insegura
}

console.log('✅ CONFIG SERVIDOR: Variables de entorno cargadas correctamente.');

// ==========================================
// SCHEMAS DE MONGOOSE
// ==========================================
const UsuarioSchema = new mongoose.Schema({
    nombre: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    plan: { type: String, enum: ['Gratis', 'Premium'], default: 'Gratis' },
    totalTiradas: { type: Number, default: 0 },
    muestrasFisicasUsadas: { type: Number, default: 0 },
    ultimaConexion: { type: String, default: () => new Date().toISOString().split('T')[0] },
    codigoPremiumUsado: { type: String, default: null }
}, { timestamps: true });

const Usuario = mongoose.models.Usuario || mongoose.model('Usuario', UsuarioSchema);

const CodigoPremiumSchema = new mongoose.Schema({
    codigo: { type: String, required: true, unique: true, uppercase: true },
    usado: { type: Boolean, default: false },
    usadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null },
    fechaUso: { type: Date, default: null }
}, { timestamps: true });

const CodigoPremium = mongoose.models.CodigoPremium || mongoose.model('CodigoPremium', CodigoPremiumSchema);

const DuplaSchema = new mongoose.Schema({
    claveBuscador: { type: String, required: true },
    cartaA: { type: String, required: true },
    cartaB: { type: String, required: true },
    significado: { type: String, required: true },
    keywords: [{ type: String }]
}, { timestamps: true, collection: 'duplas' });

DuplaSchema.index({ claveBuscador: 1 }, { unique: true });
DuplaSchema.index({ cartaA: 1, cartaB: 1 });

const Dupla = mongoose.models.Dupla || mongoose.model('Dupla', DuplaSchema);

// ==========================================
// CONEXIÓN A BASE DE DATOS
// ==========================================
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Conectado a MongoDB Atlas con éxito."))
    .catch(err => console.error('❌ Error MongoDB:', err.message));

// ==========================================
// MIDDLEWARES DE SEGURIDAD
// ==========================================
function verificarAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Acceso denegado.' });
    next();
}

function verificarAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido.' });
    try {
        req.usuario = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token invalido o expirado.' });
    }
}

// 🔒 CORRECCIÓN CRÍTICA 2: Rate Limiting para proteger tu cuota de Groq
const tiradaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 15, // Máximo 15 tiradas por IP cada 15 minutos
    message: { error: 'Demasiadas solicitudes. Por favor, espera unos minutos antes de consultar de nuevo.' }
});

// ==========================================
// RUTAS DE AUTENTICACIÓN
// ==========================================
app.post('/api/auth/registrar', async (req, res) => {
    const { nombre, email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Email invalido.' });
    }
    const nombreLimpio = (nombre && typeof nombre === 'string') ? nombre.trim() : 'Consultante';
    const emailLimpio = email.toLowerCase().trim();

    try {
        let usuario = await Usuario.findOne({ email: emailLimpio });
        if (usuario) {
            usuario.nombre = nombreLimpio;
            usuario.ultimaConexion = new Date().toISOString().split('T')[0];
            await usuario.save();
        } else {
            usuario = new Usuario({
                nombre: nombreLimpio,
                email: emailLimpio,
                plan: 'Gratis',
                totalTiradas: 0,
                muestrasFisicasUsadas: 0
            });
            await usuario.save();
        }

        const token = jwt.sign(
            { userId: usuario._id, email: usuario.email, plan: usuario.plan },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: 'Usuario registrado',
            token,
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
            }
        });
    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ error: 'Error al registrar usuario.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Email invalido.' });
    }
    const emailLimpio = email.toLowerCase().trim();

    try {
        const usuario = await Usuario.findOne({ email: emailLimpio });
        if (!usuario) {
            return res.status(404).json({ error: 'Usuario no encontrado. Registrate primero.' });
        }

        usuario.ultimaConexion = new Date().toISOString().split('T')[0];
        await usuario.save();

        const token = jwt.sign(
            { userId: usuario._id, email: usuario.email, plan: usuario.plan },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: 'Login exitoso',
            token,
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
            }
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error al iniciar sesion.' });
    }
});

app.get('/api/auth/perfil', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

        res.json({
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener perfil.' });
    }
});

app.get('/api/ping', (req, res) => {
    res.status(200).send('¡Servidor despierto y operativo! 🔮');
});

// ==========================================
// RUTAS DE CÓDIGOS PREMIUM
// ==========================================
app.post('/api/auth/canjear-codigo', verificarAuth, async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Codigo requerido.' });

    const codigoLimpio = codigo.trim().toUpperCase();

    try {
        // 🔒 CORRECCIÓN CRÍTICA 3: Eliminados los códigos hardcodeados. 
        // Ahora TODO pasa por la base de datos para tener auditoría y seguridad real.
        const codigoDB = await CodigoPremium.findOne({ codigo: codigoLimpio });
        
        if (!codigoDB) return res.status(400).json({ error: 'Codigo invalido.' });
        if (codigoDB.usado) return res.status(400).json({ error: 'Codigo ya utilizado.' });

        const usuario = await Usuario.findById(req.usuario.userId);
        usuario.plan = 'Premium';
        usuario.codigoPremiumUsado = codigoLimpio;
        await usuario.save();

        codigoDB.usado = true;
        codigoDB.usadoPor = usuario._id;
        codigoDB.fechaUso = new Date();
        await codigoDB.save();

        const nuevoToken = jwt.sign(
            { userId: usuario._id, email: usuario.email, plan: usuario.plan },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: 'Codigo premium activado con exito.',
            token: nuevoToken,
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: 999
            }
        });
    } catch (error) {
        console.error('Error al canjear codigo:', error);
        res.status(500).json({ error: 'Error al procesar el codigo.' });
    }
});

// ==========================================
// RUTAS DE TIRADAS
// ==========================================
app.post('/api/tiradas/usar-muestra', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);
        if (usuario.plan === 'Premium') {
            return res.json({ premium: true, muestrasRestantes: 999 });
        }

        const restantes = Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas);
        if (restantes <= 0) {
            return res.status(403).json({ error: 'Muestras agotadas.', muestrasRestantes: 0, premium: false });
        }

        usuario.muestrasFisicasUsadas += 1;
        await usuario.save();

        res.json({
            premium: false,
            muestrasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar muestra.' });
    }
});

app.get('/api/tiradas/muestras', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);
        res.json({
            premium: usuario.plan === 'Premium',
            muestrasRestantes: usuario.plan === 'Premium' ? 999 : Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al consultar muestras.' });
    }
});

app.post('/api/tiradas/registrar', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);
        usuario.totalTiradas += 1;
        usuario.ultimaConexion = new Date().toISOString().split('T')[0];
        await usuario.save();
        res.json({ totalTiradas: usuario.totalTiradas });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar tirada.' });
    }
});

app.get('/api/duplas/buscar', async (req, res) => {
    const { a, b } = req.query;
    if (!a || !b) return res.status(400).json({ error: 'Faltan cartas.' });

    try {
        const cartaA = a.trim();
        const cartaB = b.trim();
        
        const claves = [
            `"${cartaA}"|"${cartaB}"`,
            `${cartaA}|${cartaB}`
        ];
        
        let dupla = await Dupla.findOne({
            $or: claves.map(clave => ({ claveBuscador: clave }))
        });

        if (!dupla) {
            return res.json({ encontrada: false, mensaje: 'Dupla no encontrada' });
        }

        res.json({
            encontrada: true,
            significado: dupla.significado,
            keywords: dupla.keywords || [],
            orden: 'directo'
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: 'Error al buscar dupla.' });
    }
});

function extraerRespuesta(texto) {
    if (!texto) return '';
    const idxCierre = texto.lastIndexOf('</thinking>');
    if (idxCierre !== -1) {
        const despues = texto.substring(idxCierre + 11).trim();
        if (despues.length > 20) return despues;
    }
    const idxApertura = texto.indexOf('<thinking>');
    if (idxApertura !== -1) {
        const antes = texto.substring(0, idxApertura).trim();
        const despuesDelTag = texto.substring(idxApertura + 10);
        const idxCierre2 = despuesDelTag.indexOf('</thinking>');
        if (idxCierre2 !== -1) {
            const despues = despuesDelTag.substring(idxCierre2 + 11).trim();
            if (despues.length > 20) return despues;
        }
        if (antes.length > 20) return antes;
    }
    return texto.trim();
}

// 🔒 CORRECCIÓN CRÍTICA 4: Aplicar el rate limiter a la ruta de la IA
app.post('/tirada', tiradaLimiter, async (req, res) => {
    let { tema, a, b, c, d, estilo = 'filosofico', pregunta, cartas, modo } = req.body;
    if (!a && cartas && Array.isArray(cartas) && cartas.length >= 4) {
        a = cartas[0]; b = cartas[1]; c = cartas[2]; d = cartas[3];
    }
    if (!a || !b || !c || !d) {
        return res.status(400).json({ error: 'Faltan cartas.' });
    }
    if (!API_KEY) {
        return res.status(500).json({ error: 'API Key no configurada.' });
    }

    try {
        const preguntaLimpia = (pregunta && typeof pregunta === 'string') ? pregunta.trim().slice(0, 300) : '';
        const esPreguntaEspecifica = (tema === 'Pregunta Especifica' || tema === 'Pregunta Específica') && preguntaLimpia.length > 0;
        const esModoGratis = modo === 'gratis';

        let systemPrompt = '';
        let userPrompt = '';
        let temp = 0.7;

        if (esModoGratis) {
            systemPrompt = `Eres Morgana, experta lectora de Tarot. Tono mistico, directo y predictivo.
Responde SOLO con 2 secciones HTML con class="reading-section".
Cada seccion debe tener al menos 3 oraciones completas.
NO saludes. NO uses asteriscos ni markdown.`;
            userPrompt = `Pregunta: "${preguntaLimpia || 'Consulta general'}"
Dupla 1 (Presente): ${a} y ${b}
Dupla 2 (Futuro): ${c} y ${d}
Responde en espanol. Seccion 1 = CONCLUSION sobre la pregunta. Seccion 2 = PREDICCION.`;
        } else if (estilo === 'manual') {
            temp = 0.3;
            systemPrompt = `Actua como un diccionario tecnico, objetivo y neutral de Tarot.
Tu tarea exclusiva es analizar las dos duplas de cartas que te presenta el usuario:
- Dupla 1: ${a} y ${b}
- Dupla 2: ${c} y ${d}
Devuelve la respuesta estructurada ESTRICTAMENTE en formato HTML de la siguiente manera:
<div class="reading-section">
    <h3>Dupla 1: ${a} + ${b}</h3>
    <ul>
        <li><strong>Significado 1:</strong> [Significado practico]</li>
        <li><strong>Significado 2:</strong> [Significado practico]</li>
        <li><strong>Significado 3:</strong> [Significado practico]</li>
    </ul>
</div>
<div class="reading-section">
    <h3>Dupla 2: ${c} + ${d}</h3>
    <ul>
        <li><strong>Significado 1:</strong> [Significado practico]</li>
        <li><strong>Significado 2:</strong> [Significado practico]</li>
        <li><strong>Significado 3:</strong> [Significado practico]</li>
    </ul>
</div>
NO uses asteriscos ni markdown.`;
            userPrompt = esPreguntaEspecifica ? `Pregunta especifica: "${preguntaLimpia}". Cartas: ${a}, ${b}, ${c} y ${d}.` : `Tema general: ${tema}. Cartas: ${a}, ${b}, ${c} y ${d}.`;
        } else {
            const personalidad = (estilo === 'morgana' || estilo === 'magico')
                ? 'Eres Morgana, una experta y asertiva lectora de Tarot Rider-Waite. Tu tono es directo, mistico y predictivo.'
                : 'Eres un terapeuta y experto lector de Tarot Evolutivo. Tu tono es empatico, reflexivo y psicologico.';
            const reglasFormato = `
NO uses listas, viñetas, guiones ni asteriscos (*).
Devuelve la respuesta EXACTAMENTE en este formato HTML:
<div class="reading-section">
    <h3>El Presente y Origen (${a} + ${b})</h3>
    <p>[Interpretacion estado actual]</p>
</div>
<div class="reading-section">
    <h3>El Camino hacia el Futuro (${c} + ${d})</h3>
    <p>[Interpretacion futuro a corto plazo]</p>
</div>
<div class="reading-section">
    <h3>Predicciones del Oraculo</h3>
    <p>[2 o 3 predicciones concretas en un solo parrafo]</p>
</div>
<div class="reading-section">
    <h3>Consejo y Conclusion</h3>
    <p><span id="conclusion">[Frase de cierre y consejo final]</span></p>
</div>`;
            systemPrompt = personalidad + reglasFormato;
            userPrompt = esPreguntaEspecifica ? `Pregunta especifica: "${preguntaLimpia}". Cartas: ${a}, ${b}, ${c} y ${d}.` : `Tema general: ${tema}. Cartas: ${a}, ${b}, ${c} y ${d}.`;
        }

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: MODEL_NAME,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temp,
                max_tokens: 2500
            })
        });

        const data = await response.json();
        if (!response.ok || !data.choices || data.choices.length === 0) {
            return res.status(500).json({ error: 'Error del proveedor de IA.', detalle: data.error?.message || `HTTP ${response.status}` });
        }

        const raw = data.choices[0].message?.content || '';
        let text = extraerRespuesta(raw);

        if (!text || text.length < 30) {
            text = `<div class="reading-section"><h3>Conclusion</h3><p>La dupla ${a} y ${b} indica que la situacion actual requiere atencion y reflexion profunda.</p></div><div class="reading-section"><h3>Prediccion</h3><p>La dupla ${c} y ${d} revela un cambio significativo en el horizonte.</p></div>`;
        }

        return res.json({ lectura: text });
    } catch (error) {
        console.error('ERROR:', error.message);
        return res.status(500).json({ error: 'Error interno', detalles: error.message });
    }
});

// ==========================================
// RUTAS DE ADMINISTRACIÓN
// ==========================================
app.get('/api/admin/clientes', verificarAdmin, async (req, res) => {
    try {
        const clientes = await Usuario.find({}, { __v: 0 }).sort({ createdAt: -1 }).limit(100);
        res.json({ clientes });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener clientes' });
    }
});

app.post('/api/admin/cambiar-plan', verificarAdmin, async (req, res) => {
    const { userId, nuevoPlan } = req.body;
    if (!userId || !nuevoPlan || !['Gratis', 'Premium'].includes(nuevoPlan)) {
        return res.status(400).json({ error: 'Datos invalidos o plan incorrecto' });
    }
    try {
        const idString = String(userId).trim();
        const filtro = mongoose.Types.ObjectId.isValid(idString) ? { _id: idString } : { email: idString.toLowerCase() };
        const usuario = await Usuario.findOneAndUpdate(filtro, { $set: { plan: nuevoPlan } }, { new: true });
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ mensaje: `Plan actualizado a ${nuevoPlan}`, usuario });
    } catch (error) {
        res.status(500).json({ error: 'Error al cambiar plan' });
    }
});

app.post('/api/admin/crear-codigo', verificarAdmin, async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Codigo requerido.' });
    try {
        const nuevo = new CodigoPremium({ codigo: codigo.trim().toUpperCase() });
        await nuevo.save();
        res.json({ mensaje: 'Codigo creado', codigo: nuevo });
    } catch (error) {
        if (error.code === 11000) return res.status(400).json({ error: 'Codigo ya existe.' });
        res.status(500).json({ error: 'Error al crear codigo.' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
