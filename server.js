const express = require('express');
const { from } = require('form-data');
app = express()
port = 3005;
dotenv = require('dotenv')
mg = require('mailgun-js')
cors = require('cors')
dotenv.config()



const mailgun = () => mg({
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN
})
app.use(express.json())
app.use(express.urlencoded({ extended:true}))
app.use(cors())

app.post('/api/email', (req, res) => {
   
    const {to,subject,message} = req.body,
    emailInfo={
        from:'"Plata" <plataimobiliaria@gmail.com>',
        to: `${to}`,
        subject: `${subject}`,
        html:`${message}`

    }
    console.log(emailInfo)
   mailgun()
   .messages()
   .send(emailInfo,(error,body) => {
    if (error){
        console.log(error)
        res.status(500).send({message: 'algo correu mal ao enviar o email'})

    } else{
        res.send({message: 'email enviado'})
    }

   })
   
    
});

app.listen(port, () => {
    console.log(`Executando em http://localhost:${port}`);
});
