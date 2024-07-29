const express = require('express');
const dotenv = require('dotenv');
const mg = require('mailgun-js');
const cors = require('cors');

dotenv.config();

const app = express();
const port = 3005;

// Configurar Mailgun
const mailgun = mg({
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.post('/api/email', async (req, res) => {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
        return res.status(400).send({ message: 'Todos os campos são obrigatórios' });
    }

    const emailInfo = {
        from: '"Plata" <plataimobiliaria@gmail.com>',
        to: to,
        subject: subject,
        html: message
    };

    console.log(emailInfo);

    try {
        const body = await mailgun.messages().send(emailInfo);
        res.send({ message: 'Email enviado', body });
    } catch (error) {
        console.error('Erro ao enviar email:', error);
        res.status(500).send({ message: 'Algo correu mal ao enviar o email' });
    }
});

app.listen(port, () => {
    console.log(`Executando em http://localhost:${port}`);
});
