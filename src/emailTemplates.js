'use strict';

const I18n = require('./i18n');
const { getProduct, resolveProductOrientation } = require('./products');

const TEMPLATE_VERSION = 'transactional-2026-09-13-v3';
const CONTRACT_VERSION = 'contract-2026-09-13-v2';
const SELLER = Object.freeze({
  name: 'JUSA Engineering UG (haftungsbeschränkt)',
  address: ['Münzerstraße 6', '74080 Heilbronn', 'Deutschland'],
  registeredOffice: 'Heilbronn',
  managingDirector: 'Julian Sascha Wilken',
  register: 'Amtsgericht Stuttgart, HRB 804854',
  registerCourt: 'Amtsgericht Stuttgart',
  registrationNumber: 'HRB 804854',
  vatId: 'DE461606807',
  email: 'kontakt@jusa.io',
  phone: '+49 1523 7286173',
});

const COPY = Object.freeze({
  de: {
    testNotice: 'Dies ist eine Testbestellung. Es wurde kein echtes Geld abgebucht und kein Produktionsauftrag ausgelöst.',
    subjects: {
      order_confirmation: 'Wolkenworte – Bestellbestätigung {{number}}',
      shipment_confirmation: 'Wolkenworte – Deine Bestellung {{number}} wurde versendet',
      refund_confirmation: 'Wolkenworte – Erstattung zu {{number}}',
      cancellation_confirmation: 'Wolkenworte – Stornierung von {{number}}',
    },
    greeting: 'Hallo,',
    intros: {
      order_confirmation: 'Vielen Dank für deine Bestellung. Wir haben deine Zahlung erhalten und bestätigen deine Bestellung.',
      shipment_confirmation: 'deine personalisierte Wolkenworte-Bestellung wurde versendet.',
      refund_confirmation: 'wir haben eine Erstattung zu deiner Wolkenworte-Bestellung erfasst.',
      cancellation_confirmation: 'wir bestätigen die Stornierung deiner Wolkenworte-Bestellung.',
    },
    labels: {
      order: 'Bestellnummer', date: 'Bestell-/Zahlungsdatum', buyer: 'Kontaktadresse',
      items: 'Produkte', deliveries: 'Lieferadressen', delivery: 'Lieferadresse',
      quantity: 'Anzahl', variant: 'Variante', design: 'Designreferenz',
      itemSubtotal: 'Produktzwischensumme', shipping: 'Versand', tax: 'Steuer/USt.',
      total: 'Gesamtbetrag', refund: 'Erstattungsbetrag', carrier: 'Versanddienst',
      trackingNumber: 'Sendungsnummer', tracking: 'Sendungsverfolgung', seller: 'Vertragspartner und Kontakt',
      contract: 'Vertragsinformationen', version: 'Textversion', shipment: 'Teillieferung',
    },
    contract: 'Mit Versand dieser Bestellbestätigung nehmen wir deine Bestellung an; damit kommt der Vertrag über die oben aufgeführten personalisierten Produkte zustande. Diese E-Mail bestätigt den vereinbarten Inhalt und Preis. Die Zahlung wurde bereits über Stripe verarbeitet.',
    personalization: 'Die Produkte werden nach deinen individuellen Vorgaben angefertigt. Für Waren, die nicht vorgefertigt sind und für deren Herstellung deine individuelle Auswahl oder Bestimmung maßgeblich ist, besteht grundsätzlich kein gesetzliches Widerrufsrecht (§ 312g Abs. 2 Nr. 1 BGB). Deine gesetzlichen Rechte bei Mängeln bleiben unberührt.',
    support: 'Bei Fragen antworte bitte auf diese E-Mail oder schreibe unter Angabe der Bestellnummer an {{email}}.',
    trackingMissing: 'Der Versanddienst hat noch keinen öffentlichen Tracking-Link bereitgestellt.',
  },
  en: {
    testNotice: 'This is a test order. No real payment was charged and no production order was placed.',
    subjects: {
      order_confirmation: 'Wolkenworte – Order confirmation {{number}}',
      shipment_confirmation: 'Wolkenworte – Your order {{number}} has shipped',
      refund_confirmation: 'Wolkenworte – Refund for {{number}}',
      cancellation_confirmation: 'Wolkenworte – Cancellation of {{number}}',
    },
    greeting: 'Hello,',
    intros: {
      order_confirmation: 'Thank you for your order. We have received your payment and confirm your order.',
      shipment_confirmation: 'your personalised Wolkenworte order has been shipped.',
      refund_confirmation: 'we have recorded a refund for your Wolkenworte order.',
      cancellation_confirmation: 'we confirm the cancellation of your Wolkenworte order.',
    },
    labels: {
      order: 'Order number', date: 'Order/payment date', buyer: 'Contact address', items: 'Products',
      deliveries: 'Delivery addresses', delivery: 'Delivery address', quantity: 'Quantity', variant: 'Variant',
      design: 'Design reference', itemSubtotal: 'Product subtotal', shipping: 'Shipping', tax: 'Tax/VAT',
      total: 'Total', refund: 'Refund amount', carrier: 'Carrier', trackingNumber: 'Tracking number',
      tracking: 'Track shipment', seller: 'Contracting party and contact', contract: 'Contract information',
      version: 'Text version', shipment: 'Shipment',
    },
    contract: 'By sending this order confirmation, we accept your order and the contract for the personalised products listed above is formed. This email confirms the agreed content and price. Payment has already been processed through Stripe.',
    personalization: 'The products are made to your individual specifications. For goods that are not prefabricated and whose production is governed by your individual choice or specification, there is generally no statutory right of withdrawal (§ 312g(2)(1) German Civil Code). Your statutory rights in the event of defects remain unaffected.',
    support: 'If you have any questions, reply to this email or contact {{email}} and include your order number.',
    trackingMissing: 'The carrier has not yet provided a public tracking link.',
  },
  fr: {
    testNotice: 'Ceci est une commande de test. Aucun paiement réel n’a été prélevé et aucune production n’a été lancée.',
    subjects: {
      order_confirmation: 'Wolkenworte – Confirmation de commande {{number}}',
      shipment_confirmation: 'Wolkenworte – Votre commande {{number}} a été expédiée',
      refund_confirmation: 'Wolkenworte – Remboursement pour {{number}}',
      cancellation_confirmation: 'Wolkenworte – Annulation de {{number}}',
    },
    greeting: 'Bonjour,',
    intros: {
      order_confirmation: 'Merci pour votre commande. Nous avons reçu votre paiement et confirmons votre commande.',
      shipment_confirmation: 'votre commande Wolkenworte personnalisée a été expédiée.',
      refund_confirmation: 'nous avons enregistré un remboursement pour votre commande Wolkenworte.',
      cancellation_confirmation: 'nous confirmons l’annulation de votre commande Wolkenworte.',
    },
    labels: {
      order: 'Numéro de commande', date: 'Date de commande/paiement', buyer: 'Adresse de contact', items: 'Produits',
      deliveries: 'Adresses de livraison', delivery: 'Adresse de livraison', quantity: 'Quantité', variant: 'Variante',
      design: 'Référence du design', itemSubtotal: 'Sous-total produits', shipping: 'Livraison', tax: 'Taxes/TVA',
      total: 'Total', refund: 'Montant remboursé', carrier: 'Transporteur', trackingNumber: 'Numéro de suivi',
      tracking: 'Suivre l’envoi', seller: 'Cocontractant et contact', contract: 'Informations contractuelles',
      version: 'Version du texte', shipment: 'Envoi',
    },
    contract: 'Par l’envoi de cette confirmation, nous acceptons votre commande et le contrat portant sur les produits personnalisés indiqués ci-dessus est conclu. Cet e-mail confirme le contenu et le prix convenus. Le paiement a déjà été traité par Stripe.',
    personalization: 'Les produits sont fabriqués selon vos spécifications individuelles. Pour les biens non préfabriqués dont la fabrication dépend de votre choix ou de vos spécifications personnelles, il n’existe en principe aucun droit légal de rétractation (§ 312g, al. 2, no 1 du code civil allemand). Vos droits légaux en cas de défaut restent inchangés.',
    support: 'Pour toute question, répondez à cet e-mail ou écrivez à {{email}} en indiquant votre numéro de commande.',
    trackingMissing: 'Le transporteur n’a pas encore fourni de lien de suivi public.',
  },
  it: {
    testNotice: 'Questo è un ordine di prova. Non è stato addebitato alcun pagamento reale e non è stata avviata alcuna produzione.',
    subjects: {
      order_confirmation: 'Wolkenworte – Conferma d’ordine {{number}}',
      shipment_confirmation: 'Wolkenworte – Il tuo ordine {{number}} è stato spedito',
      refund_confirmation: 'Wolkenworte – Rimborso per {{number}}',
      cancellation_confirmation: 'Wolkenworte – Annullamento di {{number}}',
    },
    greeting: 'Ciao,',
    intros: {
      order_confirmation: 'Grazie per il tuo ordine. Abbiamo ricevuto il pagamento e confermiamo il tuo ordine.',
      shipment_confirmation: 'il tuo ordine Wolkenworte personalizzato è stato spedito.',
      refund_confirmation: 'abbiamo registrato un rimborso per il tuo ordine Wolkenworte.',
      cancellation_confirmation: 'confermiamo l’annullamento del tuo ordine Wolkenworte.',
    },
    labels: {
      order: 'Numero d’ordine', date: 'Data ordine/pagamento', buyer: 'Indirizzo di contatto', items: 'Prodotti',
      deliveries: 'Indirizzi di consegna', delivery: 'Indirizzo di consegna', quantity: 'Quantità', variant: 'Variante',
      design: 'Riferimento del design', itemSubtotal: 'Subtotale prodotti', shipping: 'Spedizione', tax: 'Imposte/IVA',
      total: 'Totale', refund: 'Importo rimborsato', carrier: 'Corriere', trackingNumber: 'Numero di tracciamento',
      tracking: 'Traccia la spedizione', seller: 'Parte contrattuale e contatti', contract: 'Informazioni contrattuali',
      version: 'Versione del testo', shipment: 'Spedizione',
    },
    contract: 'Con l’invio di questa conferma accettiamo il tuo ordine e si conclude il contratto per i prodotti personalizzati sopra indicati. Questa e-mail conferma il contenuto e il prezzo concordati. Il pagamento è già stato elaborato tramite Stripe.',
    personalization: 'I prodotti sono realizzati secondo le tue specifiche individuali. Per i beni non prefabbricati la cui produzione è determinata dalla tua scelta o specifica personale, in linea di principio non sussiste un diritto legale di recesso (§ 312g, comma 2, n. 1 del codice civile tedesco). I diritti legali in caso di difetti restano invariati.',
    support: 'Per domande, rispondi a questa e-mail o scrivi a {{email}} indicando il numero d’ordine.',
    trackingMissing: 'Il corriere non ha ancora fornito un link pubblico per il tracciamento.',
  },
  es: {
    testNotice: 'Este es un pedido de prueba. No se ha cobrado ningún pago real ni se ha iniciado la producción.',
    subjects: {
      order_confirmation: 'Wolkenworte – Confirmación del pedido {{number}}',
      shipment_confirmation: 'Wolkenworte – Tu pedido {{number}} ha sido enviado',
      refund_confirmation: 'Wolkenworte – Reembolso de {{number}}',
      cancellation_confirmation: 'Wolkenworte – Cancelación de {{number}}',
    },
    greeting: 'Hola,',
    intros: {
      order_confirmation: 'Gracias por tu pedido. Hemos recibido el pago y confirmamos tu pedido.',
      shipment_confirmation: 'tu pedido personalizado de Wolkenworte ha sido enviado.',
      refund_confirmation: 'hemos registrado un reembolso para tu pedido de Wolkenworte.',
      cancellation_confirmation: 'confirmamos la cancelación de tu pedido de Wolkenworte.',
    },
    labels: {
      order: 'Número de pedido', date: 'Fecha del pedido/pago', buyer: 'Dirección de contacto', items: 'Productos',
      deliveries: 'Direcciones de entrega', delivery: 'Dirección de entrega', quantity: 'Cantidad', variant: 'Variante',
      design: 'Referencia del diseño', itemSubtotal: 'Subtotal de productos', shipping: 'Envío', tax: 'Impuestos/IVA',
      total: 'Total', refund: 'Importe reembolsado', carrier: 'Transportista', trackingNumber: 'Número de seguimiento',
      tracking: 'Seguir el envío', seller: 'Parte contratante y contacto', contract: 'Información contractual',
      version: 'Versión del texto', shipment: 'Envío',
    },
    contract: 'Al enviar esta confirmación aceptamos tu pedido y queda celebrado el contrato de los productos personalizados indicados arriba. Este correo confirma el contenido y el precio acordados. El pago ya ha sido procesado mediante Stripe.',
    personalization: 'Los productos se fabrican conforme a tus especificaciones individuales. Para bienes no prefabricados cuya producción depende de tu elección o especificación personal, por regla general no existe derecho legal de desistimiento (§ 312g, apdo. 2, n.º 1 del Código Civil alemán). Tus derechos legales en caso de defectos no se ven afectados.',
    support: 'Si tienes preguntas, responde a este correo o escribe a {{email}} indicando el número de pedido.',
    trackingMissing: 'El transportista todavía no ha proporcionado un enlace público de seguimiento.',
  },
  tr: {
    testNotice: 'Bu bir test siparişidir. Gerçek bir ödeme alınmamış ve üretim siparişi oluşturulmamıştır.',
    subjects: {
      order_confirmation: 'Wolkenworte – {{number}} sipariş onayı',
      shipment_confirmation: 'Wolkenworte – {{number}} numaralı siparişin gönderildi',
      refund_confirmation: 'Wolkenworte – {{number}} için geri ödeme',
      cancellation_confirmation: 'Wolkenworte – {{number}} iptali',
    },
    greeting: 'Merhaba,',
    intros: {
      order_confirmation: 'Siparişin için teşekkür ederiz. Ödemeni aldık ve siparişini onaylıyoruz.',
      shipment_confirmation: 'kişiselleştirilmiş Wolkenworte siparişin gönderildi.',
      refund_confirmation: 'Wolkenworte siparişin için bir geri ödeme kaydettik.',
      cancellation_confirmation: 'Wolkenworte siparişinin iptalini onaylıyoruz.',
    },
    labels: {
      order: 'Sipariş numarası', date: 'Sipariş/ödeme tarihi', buyer: 'İletişim adresi', items: 'Ürünler',
      deliveries: 'Teslimat adresleri', delivery: 'Teslimat adresi', quantity: 'Adet', variant: 'Varyant',
      design: 'Tasarım referansı', itemSubtotal: 'Ürün ara toplamı', shipping: 'Kargo', tax: 'Vergi/KDV',
      total: 'Toplam', refund: 'Geri ödeme tutarı', carrier: 'Kargo şirketi', trackingNumber: 'Takip numarası',
      tracking: 'Gönderiyi takip et', seller: 'Sözleşme tarafı ve iletişim', contract: 'Sözleşme bilgileri',
      version: 'Metin sürümü', shipment: 'Gönderi',
    },
    contract: 'Bu sipariş onayını göndererek siparişini kabul ediyor ve yukarıda belirtilen kişiselleştirilmiş ürünlere ilişkin sözleşmeyi kuruyoruz. Bu e-posta kararlaştırılan içeriği ve fiyatı onaylar. Ödeme Stripe üzerinden işlenmiştir.',
    personalization: 'Ürünler kişisel talimatlarına göre üretilir. Önceden üretilmeyen ve üretimi kişisel seçimine veya belirlemene bağlı olan mallarda kural olarak yasal cayma hakkı bulunmaz (Alman Medeni Kanunu § 312g fıkra 2 no. 1). Ayıplara ilişkin yasal hakların saklıdır.',
    support: 'Soruların için bu e-postayı yanıtla veya sipariş numaranı belirterek {{email}} adresine yaz.',
    trackingMissing: 'Kargo şirketi henüz herkese açık bir takip bağlantısı sağlamadı.',
  },
});

const PREMIUM_COPY = Object.freeze({
  de: Object.freeze({
    headlines: {
      order_confirmation: 'Bestellung bestätigt',
      shipment_confirmation: 'Deine Bestellung ist unterwegs',
      refund_confirmation: 'Erstattung bestätigt',
      cancellation_confirmation: 'Bestellung storniert',
    },
    testLabel: 'TEST · KEINE ABBUCHUNG',
    testNotices: {
      order_confirmation: 'Dies ist eine Testbestellung. Es wurde kein echtes Geld abgebucht und kein Produktionsauftrag ausgelöst.',
      shipment_confirmation: 'Dies ist eine Testnachricht. Es wurde keine echte Sendung verschickt.',
      refund_confirmation: 'Dies ist eine Testnachricht. Es wurde keine echte Erstattung veranlasst.',
      cancellation_confirmation: 'Dies ist eine Testnachricht. Es wurde keine echte Bestellung storniert.',
    },
    details: 'Bestelldetails', event: 'Wortwolke', paymentStatus: 'Zahlungsstatus', paid: 'Bezahlt',
    designId: 'Design-ID', deliveryEstimate: 'Voraussichtliche Lieferung',
    deliveryUnavailable: 'Eine voraussichtliche Lieferzeit ist für diese Bestellung derzeit nicht verfügbar.',
    days: '{{min}}–{{max}} Tage', nextHeading: 'So geht es weiter',
    next: {
      order_confirmation: 'Wir bereiten jetzt deine personalisierten Produkte vor. Sobald sie versendet wurden, erhältst du eine weitere E-Mail.',
      shipment_confirmation: 'Mit der Sendungsverfolgung kannst du den aktuellen Stand deiner Lieferung jederzeit prüfen.',
      refund_confirmation: 'Die Erstattung geht an die ursprüngliche Zahlungsart. Wann sie sichtbar ist, hängt vom Zahlungsanbieter ab.',
      cancellation_confirmation: 'Falls bereits eine Zahlung eingezogen wurde, bestätigen wir eine zugehörige Erstattung in einer separaten E-Mail.',
    },
    testNext: 'Für diese Testbestellung ist keine weitere Aktion erforderlich.',
    customsPossible: 'Je nach Zielland können zusätzliche Zoll- oder Einfuhrgebühren anfallen.',
    customsUnknown: 'Versandursprung und mögliche Einfuhrgebühren konnten für diese Lieferung nicht abschließend bestätigt werden.',
    legalHeading: 'Vertrags- und Verbraucherinformationen', supportHeading: 'Wir sind für dich da',
    supportLead: 'Fragen zu deiner Bestellung?', seat: 'Sitz', managingDirector: 'Geschäftsführer',
    registerCourt: 'Registergericht', registrationNumber: 'Registernummer', vatId: 'USt-IdNr.',
  }),
  en: Object.freeze({
    headlines: {
      order_confirmation: 'Order confirmed',
      shipment_confirmation: 'Your order is on its way',
      refund_confirmation: 'Refund confirmed',
      cancellation_confirmation: 'Order cancelled',
    },
    testLabel: 'TEST · NO CHARGE',
    testNotices: {
      order_confirmation: 'This is a test order. No real payment was charged and no production order was placed.',
      shipment_confirmation: 'This is a test message. No real shipment was dispatched.',
      refund_confirmation: 'This is a test message. No real refund was issued.',
      cancellation_confirmation: 'This is a test message. No real order was cancelled.',
    },
    details: 'Order details', event: 'Word cloud', paymentStatus: 'Payment status', paid: 'Paid',
    designId: 'Design ID', deliveryEstimate: 'Estimated delivery',
    deliveryUnavailable: 'An estimated delivery time is currently unavailable for this order.',
    days: '{{min}}–{{max}} days', nextHeading: 'What happens next',
    next: {
      order_confirmation: 'We are now preparing your personalised products. You will receive another email as soon as they ship.',
      shipment_confirmation: 'Use the tracking link to check the latest status of your delivery.',
      refund_confirmation: 'The refund is returned to the original payment method. When it appears depends on the payment provider.',
      cancellation_confirmation: 'If payment had already been captured, we will confirm any related refund in a separate email.',
    },
    testNext: 'No further action is required for this test order.',
    customsPossible: 'Additional customs or import fees may apply depending on the destination country.',
    customsUnknown: 'The shipping origin and possible import fees could not be confirmed conclusively for this delivery.',
    legalHeading: 'Contract and consumer information', supportHeading: 'We are here to help',
    supportLead: 'Questions about your order?', seat: 'Registered office', managingDirector: 'Managing Director',
    registerCourt: 'Register court', registrationNumber: 'Registration number', vatId: 'VAT ID',
  }),
  fr: Object.freeze({
    headlines: {
      order_confirmation: 'Commande confirmée',
      shipment_confirmation: 'Votre commande est en route',
      refund_confirmation: 'Remboursement confirmé',
      cancellation_confirmation: 'Commande annulée',
    },
    testLabel: 'TEST · AUCUN DÉBIT',
    testNotices: {
      order_confirmation: 'Ceci est une commande de test. Aucun paiement réel n’a été prélevé et aucune production n’a été lancée.',
      shipment_confirmation: 'Ceci est un message de test. Aucun envoi réel n’a été expédié.',
      refund_confirmation: 'Ceci est un message de test. Aucun remboursement réel n’a été effectué.',
      cancellation_confirmation: 'Ceci est un message de test. Aucune commande réelle n’a été annulée.',
    },
    details: 'Détails de la commande', event: 'Nuage de mots', paymentStatus: 'Statut du paiement', paid: 'Payé',
    designId: 'ID du design', deliveryEstimate: 'Livraison estimée',
    deliveryUnavailable: 'Aucun délai de livraison estimé n’est actuellement disponible pour cette commande.',
    days: '{{min}}–{{max}} jours', nextHeading: 'Et maintenant ?',
    next: {
      order_confirmation: 'Nous préparons maintenant vos produits personnalisés. Vous recevrez un autre e-mail dès leur expédition.',
      shipment_confirmation: 'Utilisez le lien de suivi pour consulter à tout moment l’état de votre livraison.',
      refund_confirmation: 'Le remboursement est effectué sur le moyen de paiement initial. Le délai d’apparition dépend du prestataire de paiement.',
      cancellation_confirmation: 'Si un paiement avait déjà été prélevé, tout remboursement correspondant sera confirmé dans un e-mail distinct.',
    },
    testNext: 'Aucune autre action n’est requise pour cette commande de test.',
    customsPossible: 'Des frais de douane ou d’importation supplémentaires peuvent s’appliquer selon le pays de destination.',
    customsUnknown: 'L’origine de l’envoi et les éventuels frais d’importation n’ont pas pu être confirmés définitivement.',
    legalHeading: 'Informations contractuelles et consommateurs', supportHeading: 'Nous sommes à votre écoute',
    supportLead: 'Une question sur votre commande ?', seat: 'Siège social', managingDirector: 'Gérant',
    registerCourt: 'Tribunal du registre', registrationNumber: 'Numéro d’immatriculation', vatId: 'N° de TVA',
  }),
  it: Object.freeze({
    headlines: {
      order_confirmation: 'Ordine confermato',
      shipment_confirmation: 'Il tuo ordine è in viaggio',
      refund_confirmation: 'Rimborso confermato',
      cancellation_confirmation: 'Ordine annullato',
    },
    testLabel: 'TEST · NESSUN ADDEBITO',
    testNotices: {
      order_confirmation: 'Questo è un ordine di prova. Non è stato addebitato alcun pagamento reale e non è stata avviata alcuna produzione.',
      shipment_confirmation: 'Questo è un messaggio di prova. Non è stata effettuata alcuna spedizione reale.',
      refund_confirmation: 'Questo è un messaggio di prova. Non è stato emesso alcun rimborso reale.',
      cancellation_confirmation: 'Questo è un messaggio di prova. Non è stato annullato alcun ordine reale.',
    },
    details: 'Dettagli dell’ordine', event: 'Nuvola di parole', paymentStatus: 'Stato del pagamento', paid: 'Pagato',
    designId: 'ID design', deliveryEstimate: 'Consegna stimata',
    deliveryUnavailable: 'Al momento non è disponibile una stima dei tempi di consegna per questo ordine.',
    days: '{{min}}–{{max}} giorni', nextHeading: 'Cosa succede ora',
    next: {
      order_confirmation: 'Ora prepariamo i tuoi prodotti personalizzati. Riceverai un’altra e-mail non appena saranno spediti.',
      shipment_confirmation: 'Usa il link di tracciamento per controllare in qualsiasi momento lo stato della consegna.',
      refund_confirmation: 'Il rimborso viene restituito al metodo di pagamento originale. I tempi dipendono dal fornitore di pagamento.',
      cancellation_confirmation: 'Se il pagamento era già stato riscosso, confermeremo l’eventuale rimborso con un’e-mail separata.',
    },
    testNext: 'Non è richiesta alcuna ulteriore azione per questo ordine di prova.',
    customsPossible: 'A seconda del Paese di destinazione possono essere applicati ulteriori dazi o costi di importazione.',
    customsUnknown: 'L’origine della spedizione e gli eventuali costi di importazione non hanno potuto essere confermati in modo definitivo.',
    legalHeading: 'Informazioni contrattuali e per il consumatore', supportHeading: 'Siamo qui per aiutarti',
    supportLead: 'Domande sul tuo ordine?', seat: 'Sede legale', managingDirector: 'Amministratore delegato',
    registerCourt: 'Tribunale del registro', registrationNumber: 'Numero di registrazione', vatId: 'Partita IVA',
  }),
  es: Object.freeze({
    headlines: {
      order_confirmation: 'Pedido confirmado',
      shipment_confirmation: 'Tu pedido está en camino',
      refund_confirmation: 'Reembolso confirmado',
      cancellation_confirmation: 'Pedido cancelado',
    },
    testLabel: 'PRUEBA · SIN CARGO',
    testNotices: {
      order_confirmation: 'Este es un pedido de prueba. No se ha cobrado ningún pago real ni se ha iniciado la producción.',
      shipment_confirmation: 'Este es un mensaje de prueba. No se ha realizado ningún envío real.',
      refund_confirmation: 'Este es un mensaje de prueba. No se ha emitido ningún reembolso real.',
      cancellation_confirmation: 'Este es un mensaje de prueba. No se ha cancelado ningún pedido real.',
    },
    details: 'Detalles del pedido', event: 'Nube de palabras', paymentStatus: 'Estado del pago', paid: 'Pagado',
    designId: 'ID del diseño', deliveryEstimate: 'Entrega estimada',
    deliveryUnavailable: 'Actualmente no hay un plazo de entrega estimado disponible para este pedido.',
    days: '{{min}}–{{max}} días', nextHeading: 'Qué sucede ahora',
    next: {
      order_confirmation: 'Ahora prepararemos tus productos personalizados. Recibirás otro correo en cuanto se envíen.',
      shipment_confirmation: 'Utiliza el enlace de seguimiento para consultar en cualquier momento el estado de la entrega.',
      refund_confirmation: 'El reembolso se devuelve al método de pago original. El plazo depende del proveedor de pago.',
      cancellation_confirmation: 'Si el pago ya se había cobrado, confirmaremos cualquier reembolso relacionado en un correo separado.',
    },
    testNext: 'No es necesaria ninguna otra acción para este pedido de prueba.',
    customsPossible: 'Según el país de destino, pueden aplicarse gastos adicionales de aduana o importación.',
    customsUnknown: 'No se han podido confirmar de forma concluyente el origen del envío ni los posibles gastos de importación.',
    legalHeading: 'Información contractual y para consumidores', supportHeading: 'Estamos aquí para ayudarte',
    supportLead: '¿Preguntas sobre tu pedido?', seat: 'Domicilio social', managingDirector: 'Administrador',
    registerCourt: 'Registro mercantil', registrationNumber: 'Número de registro', vatId: 'NIF-IVA',
  }),
  tr: Object.freeze({
    headlines: {
      order_confirmation: 'Sipariş onaylandı',
      shipment_confirmation: 'Siparişin yola çıktı',
      refund_confirmation: 'Geri ödeme onaylandı',
      cancellation_confirmation: 'Sipariş iptal edildi',
    },
    testLabel: 'TEST · ÜcRET ALINMADI',
    testNotices: {
      order_confirmation: 'Bu bir test siparişidir. Gerçek bir ödeme alınmamış ve üretim siparişi oluşturulmamıştır.',
      shipment_confirmation: 'Bu bir test mesajıdır. Gerçek bir gönderi yapılmamıştır.',
      refund_confirmation: 'Bu bir test mesajıdır. Gerçek bir geri ödeme yapılmamıştır.',
      cancellation_confirmation: 'Bu bir test mesajıdır. Gerçek bir sipariş iptal edilmemiştir.',
    },
    details: 'Sipariş ayrıntıları', event: 'Kelime bulutu', paymentStatus: 'Ödeme durumu', paid: 'Ödendi',
    designId: 'Tasarım kimliği', deliveryEstimate: 'Tahmini teslimat',
    deliveryUnavailable: 'Bu sipariş için şu anda tahmini teslimat süresi mevcut değil.',
    days: '{{min}}–{{max}} gün', nextHeading: 'Bundan sonra ne olacak?',
    next: {
      order_confirmation: 'Kişiselleştirilmiş ürünlerini hazırlıyoruz. Gönderildiğinde yeni bir e-posta alacaksın.',
      shipment_confirmation: 'Teslimatının güncel durumunu istediğin zaman takip bağlantısından kontrol edebilirsin.',
      refund_confirmation: 'Geri ödeme ilk ödeme yöntemine yapılır. Hesabında görünme süresi ödeme sağlayıcısına bağlıdır.',
      cancellation_confirmation: 'Ödeme daha önce alındıysa ilgili geri ödemeyi ayrı bir e-postayla onaylayacağız.',
    },
    testNext: 'Bu test siparişi için başka bir işlem yapman gerekmez.',
    customsPossible: 'Hedef ülkeye bağlı olarak ek gümrük veya ithalat ücretleri uygulanabilir.',
    customsUnknown: 'Bu teslimat için gönderim kaynağı ve olası ithalat ücretleri kesin olarak doğrulanamadı.',
    legalHeading: 'Sözleşme ve tüketici bilgileri', supportHeading: 'Yardım için buradayız',
    supportLead: 'Siparişinle ilgili sorun mu var?', seat: 'Merkez', managingDirector: 'Genel Müdür',
    registerCourt: 'Sicil mahkemesi', registrationNumber: 'Sicil numarası', vatId: 'KDV No.',
  }),
});

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function interpolate(value, params) {
  return String(value).replace(/\{\{(\w+)\}\}/g, (match, key) => (
    Object.hasOwn(params, key) ? String(params[key]) : match
  ));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function htmlLine(value) {
  return String(value == null ? '' : value).split(/(https?:\/\/[^\s]+)/g).map((part) => {
    if (!/^https?:\/\//.test(part)) return escapeHtml(part);
    return `<a href="${escapeHtml(part)}" style="color:#a40e4c">${escapeHtml(part)}</a>`;
  }).join('');
}

function orderNumber(order) {
  return `WW-${String(order.id).padStart(8, '0')}`;
}

function money(cents, currency, locale) {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currency || 'EUR' })
    .format(Number(cents || 0) / 100);
}

function dateTime(value, locale) {
  const parsed = new Date(value || Date.now());
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Berlin', timeZoneName: 'short',
  }).format(Number.isNaN(parsed.getTime()) ? new Date() : parsed);
}

function addressLines(rawRecipient, locale) {
  const recipient = parseJson(rawRecipient, {});
  let country = recipient.country_name || recipient.country || recipient.country_code || '';
  if (recipient.country_code) {
    try { country = new Intl.DisplayNames([locale], { type: 'region' }).of(recipient.country_code) || country; } catch {}
  }
  return [
    recipient.name,
    recipient.company,
    recipient.address1,
    recipient.address2,
    [recipient.zip, recipient.city].filter(Boolean).join(' '),
    recipient.state_name || recipient.state_code,
    country,
  ].filter((value) => String(value || '').trim()).map(String);
}

function itemView(item, locale) {
  const snapshot = parseJson(item.configuration_snapshot_json, {});
  const base = getProduct(snapshot.productKey || item.product_key);
  const product = resolveProductOrientation(base, snapshot.orientation || 'default') || base;
  return {
    quantity: Number(item.quantity),
    name: I18n.translate(product?.name || snapshot.productKey || item.product_key, locale),
    size: I18n.translate(product?.size?.label || '', locale),
    design: String(snapshot.configurationId || item.configuration_id || `order-item-${item.id}`),
  };
}

function localizedSellerAddress(locale) {
  let country = SELLER.address[SELLER.address.length - 1];
  try { country = new Intl.DisplayNames([locale], { type: 'region' }).of('DE') || country; } catch {}
  return [...SELLER.address.slice(0, -1), country];
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deliverySummary(shipping, locale, premium) {
  const delivery = shipping?.delivery || {};
  const minDate = dateOnly(delivery.minDate);
  const maxDate = dateOnly(delivery.maxDate);
  if (minDate && maxDate) {
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
    return typeof formatter.formatRange === 'function'
      ? formatter.formatRange(minDate, maxDate)
      : `${formatter.format(minDate)} – ${formatter.format(maxDate)}`;
  }
  if (Number.isInteger(delivery.minDays) && Number.isInteger(delivery.maxDays)) {
    return interpolate(premium.days, { min: delivery.minDays, max: delivery.maxDays });
  }
  return premium.deliveryUnavailable;
}

function customsNotice(shipping, premium) {
  const assessments = Array.isArray(shipping?.shipments)
    ? shipping.shipments.map((entry) => entry?.customsFeesPossible)
    : [];
  if (assessments.some((value) => value === true)) return premium.customsPossible;
  if (assessments.some((value) => value == null)) return premium.customsUnknown;
  return '';
}

function storedShippingEntries(order) {
  const stored = parseJson(order?.shipping_json, []);
  return Array.isArray(stored) ? stored : [];
}

function shippingTermsAt(order, shipmentIndex) {
  const stored = storedShippingEntries(order);
  const exact = stored.find((entry, index) => Number(entry?.shipmentIndex ?? index) === Number(shipmentIndex));
  return exact?.printfulShipping || exact?.shippingDetails || null;
}

function sellerLines(locale, premium) {
  return [
    SELLER.name,
    ...localizedSellerAddress(locale),
    `${premium.seat}: ${SELLER.registeredOffice}`,
    `${premium.managingDirector}: ${SELLER.managingDirector}`,
    `${premium.registerCourt}: ${SELLER.registerCourt}`,
    `${premium.registrationNumber}: ${SELLER.registrationNumber}`,
    `${premium.vatId}: ${SELLER.vatId}`,
    `${SELLER.email} · ${SELLER.phone}`,
  ];
}

function buildEmailModel({ kind, order, orderItems, shipments, shipment, noticeAmountCents, locale, copy, premium }) {
  const labels = copy.labels;
  const allItems = kind === 'shipment_confirmation' && shipment
    ? orderItems.filter((item) => Number(item.shipment_index) === Number(shipment.shipment_index))
    : orderItems;
  const items = allItems.map((item) => itemView(item, locale));
  const selectedShipments = kind === 'shipment_confirmation' && shipment ? [shipment] : shipments;
  const deliveries = selectedShipments.map((entry, index) => {
    const shipmentIndex = Number(entry.shipment_index ?? index);
    const shipping = shippingTermsAt(order, shipmentIndex);
    return {
      number: shipmentIndex + 1,
      address: addressLines(entry.recipient_json, locale),
      estimate: deliverySummary(shipping, locale, premium),
      customs: customsNotice(shipping, premium),
    };
  });
  const financialRows = [];
  if (kind === 'order_confirmation') {
    financialRows.push(
      [labels.itemSubtotal, money(order.items_cents, order.currency, locale)],
      [labels.shipping, money(order.shipping_cents, order.currency, locale)],
      [labels.tax, money(order.tax_cents, order.currency, locale)],
      [labels.total, money(order.total_cents, order.currency, locale), true]
    );
  } else if (kind === 'refund_confirmation') {
    financialRows.push(
      [labels.refund, money(noticeAmountCents ?? order.refunded_cents ?? order.total_cents, order.currency, locale), true],
      [labels.total, money(order.total_cents, order.currency, locale)]
    );
  } else if (kind === 'cancellation_confirmation') {
    financialRows.push([labels.total, money(order.total_cents, order.currency, locale), true]);
  }
  const trackingUrl = /^https:\/\//.test(String(shipment?.tracking_url || ''))
    ? String(shipment.tracking_url)
    : null;
  return {
    kind,
    number: orderNumber(order),
    headline: premium.headlines[kind],
    greeting: copy.greeting,
    intro: copy.intros[kind],
    eventTitle: String(order.event_title_snapshot || '').trim(),
    date: dateTime(order.paid_at || order.created_at, locale),
    buyerEmail: order.buyer_email || '—',
    items,
    deliveries,
    financialRows,
    shipment: kind === 'shipment_confirmation' && shipment ? {
      number: Number(shipment.shipment_index) + 1,
      carrier: shipment.carrier || '—',
      trackingNumber: shipment.tracking_number || '—',
      trackingUrl,
    } : null,
    contract: kind === 'order_confirmation' ? [copy.contract, copy.personalization] : [],
    next: premium.next[kind],
    seller: sellerLines(locale, premium),
  };
}

function renderText(copy, premium, model, { isTestOrder }) {
  const lines = [
    'WOLKENWORTE',
    ...(isTestOrder ? ['', premium.testLabel, premium.testNotices[model.kind]] : []),
    '', model.headline, model.number, '', model.greeting, '', model.intro, '',
    premium.details,
    `${copy.labels.order}: ${model.number}`,
    `${copy.labels.date}: ${model.date}`,
    ...(model.eventTitle ? [`${premium.event}: ${model.eventTitle}`] : []),
    `${copy.labels.buyer}: ${model.buyerEmail}`,
    ...(model.kind === 'order_confirmation' ? [`${premium.paymentStatus}: ${premium.paid}`] : []),
    '', copy.labels.items,
    ...model.items.flatMap((item) => [
      `${item.quantity} × ${item.name}${item.size ? ` · ${item.size}` : ''}`,
      `${premium.designId}: ${item.design}`,
    ]),
  ];
  if (model.deliveries.length) {
    lines.push('', copy.labels.deliveries);
    for (const delivery of model.deliveries) {
      lines.push(`${copy.labels.delivery} ${delivery.number}`, ...delivery.address,
        `${premium.deliveryEstimate}: ${delivery.estimate}`);
      if (delivery.customs) lines.push(delivery.customs);
    }
  }
  if (model.shipment) {
    lines.push('', `${copy.labels.shipment}: ${model.shipment.number}`,
      `${copy.labels.carrier}: ${model.shipment.carrier}`,
      `${copy.labels.trackingNumber}: ${model.shipment.trackingNumber}`,
      model.shipment.trackingUrl
        ? `${copy.labels.tracking}: ${model.shipment.trackingUrl}`
        : copy.trackingMissing);
  }
  if (model.financialRows.length) {
    lines.push('', ...model.financialRows.map(([label, value]) => `${label}: ${value}`));
  }
  lines.push('', premium.nextHeading, isTestOrder ? premium.testNext : model.next);
  if (model.contract.length) lines.push('', premium.legalHeading, ...model.contract);
  lines.push('', copy.labels.seller, ...model.seller, '', premium.supportHeading,
    interpolate(copy.support, { email: SELLER.email }));
  return lines.join('\n').trim() + '\n';
}

function sectionHeading(value) {
  return `<h2 style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;` +
    `letter-spacing:1.6px;text-transform:uppercase;color:#9d3158;font-weight:700">${escapeHtml(value)}</h2>`;
}

function renderDetailsHtml(copy, premium, model) {
  const rows = [
    [copy.labels.order, model.number],
    [copy.labels.date, model.date],
    ...(model.eventTitle ? [[premium.event, model.eventTitle]] : []),
    [copy.labels.buyer, model.buyerEmail],
    ...(model.kind === 'order_confirmation' ? [[premium.paymentStatus, premium.paid]] : []),
  ];
  return `<tr><td style="padding:32px 40px 8px">${sectionHeading(premium.details)}` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0;background:#fbf7f4;border:1px solid #eee1dc;border-radius:14px">` +
    rows.map(([label, value], index) => `<tr><td style="padding:${index ? '8px' : '18px'} 20px ${index === rows.length - 1 ? '18px' : '8px'};width:42%;font-size:13px;line-height:20px;color:#8a7378;vertical-align:top">${escapeHtml(label)}</td>` +
      `<td style="padding:${index ? '8px' : '18px'} 20px ${index === rows.length - 1 ? '18px' : '8px'};font-size:14px;line-height:20px;color:#2b2023;font-weight:600;text-align:right;vertical-align:top;overflow-wrap:anywhere">${escapeHtml(value)}</td></tr>`).join('') +
    '</table></td></tr>';
}

function renderItemsHtml(copy, premium, model) {
  if (!model.items.length) return '';
  const items = model.items.map((item, index) => `<tr><td style="padding:${index ? '16px' : '4px'} 0 16px;${index ? 'border-top:1px solid #eee5e2;' : ''}">` +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>' +
    `<td style="width:44px;vertical-align:top"><div style="width:38px;height:38px;border-radius:19px;background:#f6dce5;color:#8b1744;text-align:center;line-height:38px;font-size:15px;font-weight:700">${escapeHtml(item.quantity)}×</div></td>` +
    `<td style="padding-left:12px;vertical-align:top"><div style="font-size:16px;line-height:23px;color:#2b2023;font-weight:700">${escapeHtml(item.name)}</div>` +
    `${item.size ? `<div style="margin-top:2px;font-size:13px;line-height:19px;color:#79666b">${escapeHtml(item.size)}</div>` : ''}` +
    `<div style="margin-top:5px;font-size:11px;line-height:16px;color:#9a878b;overflow-wrap:anywhere">${escapeHtml(premium.designId)}: ${escapeHtml(item.design)}</div></td>` +
    '</tr></table></td></tr>').join('');
  return `<tr><td style="padding:28px 40px 4px">${sectionHeading(copy.labels.items)}` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${items}</table></td></tr>`;
}

function renderDeliveriesHtml(copy, premium, model) {
  if (!model.deliveries.length) return '';
  const cards = model.deliveries.map((delivery) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 12px;border-collapse:separate;border-spacing:0;border:1px solid #eee1dc;border-radius:14px"><tr>` +
    `<td style="padding:18px 20px;font-size:14px;line-height:21px;color:#46373b;vertical-align:top"><strong style="color:#2b2023">${escapeHtml(copy.labels.delivery)} ${delivery.number}</strong><br>` +
    `${delivery.address.map(escapeHtml).join('<br>')}</td>` +
    `<td style="padding:18px 20px;text-align:right;vertical-align:top"><div style="font-size:11px;line-height:16px;letter-spacing:.8px;text-transform:uppercase;color:#9a878b">${escapeHtml(premium.deliveryEstimate)}</div>` +
    `<div style="margin-top:5px;font-size:14px;line-height:20px;color:#5d1230;font-weight:700">${escapeHtml(delivery.estimate)}</div></td></tr>` +
    `${delivery.customs ? `<tr><td colspan="2" style="padding:0 20px 18px;font-size:12px;line-height:18px;color:#806a42">${escapeHtml(delivery.customs)}</td></tr>` : ''}` +
    '</table>').join('');
  return `<tr><td style="padding:28px 40px 4px">${sectionHeading(copy.labels.deliveries)}${cards}</td></tr>`;
}

function renderShipmentHtml(copy, model) {
  if (!model.shipment) return '';
  const trackingButton = model.shipment.trackingUrl
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:18px"><tr><td bgcolor="#5d1230" style="border-radius:999px"><a href="${escapeHtml(model.shipment.trackingUrl)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-size:14px;line-height:20px;font-weight:700">${escapeHtml(copy.labels.tracking)} &nbsp;→</a></td></tr></table>`
    : `<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#79666b">${escapeHtml(copy.trackingMissing)}</p>`;
  return `<tr><td style="padding:28px 40px 4px">${sectionHeading(copy.labels.shipment)}` +
    `<div style="padding:20px;background:#fbf7f4;border:1px solid #eee1dc;border-radius:14px"><div style="font-size:14px;line-height:22px;color:#46373b">` +
    `<strong>${escapeHtml(copy.labels.carrier)}:</strong> ${escapeHtml(model.shipment.carrier)}<br>` +
    `<strong>${escapeHtml(copy.labels.trackingNumber)}:</strong> ${escapeHtml(model.shipment.trackingNumber)}</div>${trackingButton}</div></td></tr>`;
}

function renderTotalsHtml(model) {
  if (!model.financialRows.length) return '';
  return `<tr><td style="padding:28px 40px 4px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse">` +
    model.financialRows.map(([label, value, strong], index) => `<tr><td style="padding:${strong ? '15px 0 4px' : '5px 0'};${strong && index ? 'border-top:1px solid #e7d8d3;' : ''}font-size:${strong ? '16px' : '14px'};line-height:22px;color:${strong ? '#2b2023' : '#79666b'};font-weight:${strong ? '700' : '400'}">${escapeHtml(label)}</td>` +
      `<td style="padding:${strong ? '15px 0 4px' : '5px 0'};${strong && index ? 'border-top:1px solid #e7d8d3;' : ''}font-size:${strong ? '20px' : '14px'};line-height:22px;text-align:right;color:${strong ? '#5d1230' : '#46373b'};font-weight:${strong ? '700' : '600'};white-space:nowrap">${escapeHtml(value)}</td></tr>`).join('') +
    '</table></td></tr>';
}

function renderHtml(copy, premium, model, { isTestOrder }) {
  const testBanner = isTestOrder ? `<tr><td style="padding:14px 40px;background:#fff4d8;border-bottom:1px solid #f0dfaf;color:#73591c;font-size:12px;line-height:18px;text-align:center">` +
    `<strong style="letter-spacing:.8px">${escapeHtml(premium.testLabel)}</strong><br>${escapeHtml(premium.testNotices[model.kind])}</td></tr>` : '';
  const legal = model.contract.length ? `<tr><td style="padding:30px 40px 4px">${sectionHeading(premium.legalHeading)}` +
    `<div data-contract-version="${escapeHtml(CONTRACT_VERSION)}" style="padding:18px 20px;background:#f7f4f0;border-radius:14px;font-size:13px;line-height:20px;color:#625156">` +
    model.contract.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`).join('').replace(/margin:0 0 12px">([^<]*)<\/p>$/, 'margin:0">$1</p>') +
    '</div></td></tr>' : '';
  const support = interpolate(copy.support, { email: SELLER.email });
  const supportHtml = escapeHtml(support).replace(
    escapeHtml(SELLER.email),
    `<a href="mailto:${escapeHtml(SELLER.email)}" style="color:#9d174d;text-decoration:underline">${escapeHtml(SELLER.email)}</a>`
  );
  const seller = model.seller.map(escapeHtml).join('<br>');
  const preheader = `${model.headline} · ${model.number}`;
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<style>@media screen and (max-width:680px){.ww-shell{width:100%!important}.ww-pad{padding-left:22px!important;padding-right:22px!important}.ww-hero{font-size:32px!important;line-height:38px!important}.ww-delivery td{display:block!important;width:auto!important;text-align:left!important}.ww-delivery td+td{padding-top:0!important}}</style></head>' +
    '<body style="margin:0;padding:0;background:#f4efec;color:#2b2023;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">' +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>` +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4efec" style="width:100%;border-collapse:collapse"><tr><td align="center" style="padding:28px 12px">' +
    '<table role="presentation" width="640" cellspacing="0" cellpadding="0" class="ww-shell" style="width:640px;max-width:640px;border-collapse:separate;border-spacing:0;background:#fffdfb;border-radius:20px;overflow:hidden;box-shadow:0 14px 44px rgba(75,0,24,.10)">' +
    '<tr><td class="ww-pad" style="padding:24px 40px;background:#fffdfb"><table role="presentation" cellspacing="0" cellpadding="0"><tr>' +
    '<td style="vertical-align:middle"><img src="cid:wolkenworte-mark-v1" width="44" height="41" alt="" style="display:block;border:0;width:44px;height:41px"></td>' +
    '<td style="padding-left:12px;vertical-align:middle;font-family:Georgia,Times New Roman,serif;font-size:24px;line-height:30px;color:#4b0018;font-weight:700">Wolkenworte</td>' +
    `</tr></table></td></tr>${testBanner}` +
    '<tr><td class="ww-pad" style="padding:40px;background:#5d1230;color:#ffffff">' +
    `<div style="font-size:12px;line-height:18px;letter-spacing:1.8px;text-transform:uppercase;color:#efb8ca;font-weight:700">${escapeHtml(model.number)}</div>` +
    `<h1 class="ww-hero" style="margin:10px 0 16px;font-family:Georgia,Times New Roman,serif;font-size:40px;line-height:46px;font-weight:400;color:#ffffff">${escapeHtml(model.headline)} <span style="color:#ef9eb9">♡</span></h1>` +
    `<p style="margin:0 0 10px;font-size:15px;line-height:23px;color:#f8e9ee">${escapeHtml(model.greeting)}</p>` +
    `<p style="margin:0;font-size:16px;line-height:25px;color:#ffffff">${escapeHtml(model.intro)}</p></td></tr>` +
    renderDetailsHtml(copy, premium, model).replace('padding:32px 40px 8px', 'padding:32px 40px 8px" class="ww-pad') +
    renderItemsHtml(copy, premium, model).replace('padding:28px 40px 4px', 'padding:28px 40px 4px" class="ww-pad') +
    renderDeliveriesHtml(copy, premium, model).replace('padding:28px 40px 4px', 'padding:28px 40px 4px" class="ww-pad').replaceAll('<table role="presentation" width="100%"', '<table role="presentation" width="100%" class="ww-delivery"') +
    renderShipmentHtml(copy, model).replace('padding:28px 40px 4px', 'padding:28px 40px 4px" class="ww-pad') +
    renderTotalsHtml(model).replace('padding:28px 40px 4px', 'padding:28px 40px 4px" class="ww-pad') +
    `<tr><td class="ww-pad" style="padding:30px 40px 4px">${sectionHeading(premium.nextHeading)}<div style="padding:18px 20px;background:#fdf1f5;border-left:3px solid #c83268;border-radius:0 14px 14px 0;font-size:14px;line-height:22px;color:#51343d">${escapeHtml(isTestOrder ? premium.testNext : model.next)}</div></td></tr>` +
    legal.replace('padding:30px 40px 4px', 'padding:30px 40px 4px" class="ww-pad') +
    `<tr><td class="ww-pad" style="padding:30px 40px 34px"><div style="border-top:1px solid #eee1dc;padding-top:26px">${sectionHeading(premium.supportHeading)}` +
    `<p style="margin:0 0 9px;font-size:15px;line-height:23px;color:#2b2023;font-weight:700">${escapeHtml(premium.supportLead)}</p>` +
    `<p style="margin:0;font-size:14px;line-height:22px;color:#6e5a60">${supportHtml}</p></div></td></tr>` +
    `<tr><td class="ww-pad" style="padding:24px 40px 28px;background:#f7f4f0;font-size:11px;line-height:17px;color:#7d6d71">${seller}<br><br>` +
    `<a href="mailto:${escapeHtml(SELLER.email)}" style="color:#7d3150">${escapeHtml(SELLER.email)}</a> · <a href="tel:${escapeHtml(SELLER.phone.replace(/\s/g, ''))}" style="color:#7d3150">${escapeHtml(SELLER.phone)}</a>` +
    '</td></tr></table></td></tr></table></body></html>';
}

function buildEmailSnapshot({
  kind,
  order,
  orderItems = [],
  shipments = [],
  shipment = null,
  noticeAmountCents = null,
  locale = order?.locale_snapshot,
}) {
  const normalizedLocale = I18n.normalizeLocale(locale);
  const copy = COPY[normalizedLocale] || COPY.de;
  const premium = PREMIUM_COPY[normalizedLocale] || PREMIUM_COPY.de;
  if (!copy.subjects[kind] || !copy.intros[kind]) throw new Error('unsupported transactional email kind');
  const number = orderNumber(order);
  const isTestOrder = order?.mode === 'test' || order?.status === 'paid_test';
  const model = buildEmailModel({
    kind, order, orderItems, shipments, shipment, noticeAmountCents,
    locale: normalizedLocale, copy, premium,
  });
  return {
    locale: normalizedLocale,
    templateVersion: TEMPLATE_VERSION,
    subject: (isTestOrder ? '[TEST] ' : '') + interpolate(copy.subjects[kind], { number }),
    textBody: renderText(copy, premium, model, { isTestOrder }),
    htmlBody: renderHtml(copy, premium, model, { isTestOrder }),
  };
}

module.exports = {
  TEMPLATE_VERSION,
  CONTRACT_VERSION,
  SELLER,
  orderNumber,
  buildEmailSnapshot,
};
