const express = require('express');
const dotenv = require('dotenv');
const mg = require('mailgun-js');
const cors = require('cors');
const pLimit = require('p-limit');

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

const sendEmail = async (emailInfo) => {
    return new Promise((resolve, reject) => {
        mailgun.messages().send(emailInfo, (error, body) => {
            if (error) {
                console.error('Erro ao enviar email:', error);
                reject(error);
            } else {
                console.log('Email enviado com sucesso:', body);
                resolve(body);
            }
        });
    });
};

app.post('/api/email', async (req, res) => {
    const { to, subject, message } = req.body;

    if (!to || !subject || !message) {
        return res.status(400).send({ message: 'Todos os campos são obrigatórios' });
    }

    const recipients = Array.isArray(to) ? to : [to]; // Suporta envio para múltiplos destinatários

    const emailInfo = recipients.map((recipient) => ({
        from: '"Plata" <plataimobiliaria@gmail.com>',
        to: recipient,
        subject: subject,
        html: message
    }));

    const limit = pLimit(10); // Limitar a 10 requisições simultâneas (ajuste conforme necessário)
    const sendEmailTasks = emailInfo.map((info) => limit(() => sendEmail(info)));

    try {
        const results = await Promise.all(sendEmailTasks);
        res.send({ message: 'Emails enviados', results });
    } catch (error) {
        console.error('Erro ao enviar emails:', error);
        res.status(500).send({ message: 'Algo correu mal ao enviar os emails' });
    }
});

app.listen(port, () => {
    console.log(`Executando em http://localhost:${port}`);
});
