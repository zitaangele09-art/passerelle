// Envoi des codes par SMS.
// Sans variable SMS_PROVIDER : mode TEST. Le code est écrit dans les journaux ET renvoyé à l'application
// (« devCode ») pour pouvoir essayer sans SMS. À ne jamais laisser ainsi avec de vrais clients.
// Pour un vrai envoi : définissez SMS_PROVIDER et branchez l'API de votre prestataire SMS ci-dessous.
module.exports = {
  async send(phone, text) {
    const p = process.env.SMS_PROVIDER;
    if (!p) { console.log('[SMS test]', phone, text); return { devCode: true }; }
    // Exemple à compléter avec l'API de votre prestataire (clés dans des variables d'environnement) :
    // await fetch('https://…', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.SMS_KEY }, body: … });
    throw new Error('Prestataire SMS « ' + p + ' » non implémenté dans sms.js');
  }
};
