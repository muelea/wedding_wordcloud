'use strict';

const I18n = require('./i18n');
const { getProduct, resolveProductOrientation } = require('./products');

const TEMPLATE_VERSION = 'transactional-2026-09-03-v2';
const CONTRACT_VERSION = 'contract-2026-08-27-v1';
const SELLER = Object.freeze({
  name: 'JUSA Engineering UG (haftungsbeschränkt)',
  address: ['Münzerstraße 6', '74080 Heilbronn', 'Deutschland'],
  managingDirector: 'Julian Sascha Wilken',
  register: 'Amtsgericht Stuttgart, HRB 804854',
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
      order_confirmation: 'vielen Dank für deine Bestellung. Wir haben deine Zahlung erhalten und bestätigen die Bestellung mit den folgenden unveränderlichen Angaben.',
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
    contract: 'Mit Versand dieser Bestellbestätigung nehmen wir deine Bestellung an; damit kommt der Vertrag über die oben aufgeführten personalisierten Produkte zustande. Die Zahlung wurde bereits über Stripe verarbeitet. Maßgeblich für Inhalt und Preis sind ausschließlich die unveränderlichen Bestellangaben in dieser E-Mail.',
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
      order_confirmation: 'thank you for your order. We have received your payment and confirm the order with the following immutable details.',
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
    contract: 'By sending this order confirmation, we accept your order and the contract for the personalised products listed above is formed. Payment has already been processed through Stripe. Only the immutable order details in this email determine the content and price of the contract.',
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
      order_confirmation: 'merci pour votre commande. Nous avons reçu votre paiement et confirmons la commande avec les informations immuables suivantes.',
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
    contract: 'Par l’envoi de cette confirmation, nous acceptons votre commande et le contrat portant sur les produits personnalisés indiqués ci-dessus est conclu. Le paiement a déjà été traité par Stripe. Seules les informations immuables de cette e-mail déterminent le contenu et le prix du contrat.',
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
      order_confirmation: 'grazie per il tuo ordine. Abbiamo ricevuto il pagamento e confermiamo l’ordine con i seguenti dati immutabili.',
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
    contract: 'Con l’invio di questa conferma accettiamo il tuo ordine e si conclude il contratto per i prodotti personalizzati sopra indicati. Il pagamento è già stato elaborato tramite Stripe. Solo i dati immutabili contenuti in questa e-mail determinano contenuto e prezzo del contratto.',
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
      order_confirmation: 'gracias por tu pedido. Hemos recibido el pago y confirmamos el pedido con los siguientes datos inmutables.',
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
    contract: 'Al enviar esta confirmación aceptamos tu pedido y queda celebrado el contrato de los productos personalizados indicados arriba. El pago ya ha sido procesado mediante Stripe. Únicamente los datos inmutables de este correo determinan el contenido y el precio del contrato.',
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
      order_confirmation: 'siparişin için teşekkür ederiz. Ödemeni aldık ve aşağıdaki değiştirilemez bilgilerle siparişini onaylıyoruz.',
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
    contract: 'Bu sipariş onayını göndererek siparişini kabul ediyor ve yukarıda belirtilen kişiselleştirilmiş ürünlere ilişkin sözleşmeyi kuruyoruz. Ödeme Stripe üzerinden işlenmiştir. Sözleşmenin içeriği ve fiyatı yalnızca bu e-postadaki değiştirilemez sipariş bilgilerine göre belirlenir.',
    personalization: 'Ürünler kişisel talimatlarına göre üretilir. Önceden üretilmeyen ve üretimi kişisel seçimine veya belirlemene bağlı olan mallarda kural olarak yasal cayma hakkı bulunmaz (Alman Medeni Kanunu § 312g fıkra 2 no. 1). Ayıplara ilişkin yasal hakların saklıdır.',
    support: 'Soruların için bu e-postayı yanıtla veya sipariş numaranı belirterek {{email}} adresine yaz.',
    trackingMissing: 'Kargo şirketi henüz herkese açık bir takip bağlantısı sağlamadı.',
  },
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
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin',
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
    variant: String(item.printful_variant_id),
    design: String(snapshot.configurationId || item.configuration_id || `order-item-${item.id}`),
  };
}

function sellerLines(locale, copy) {
  return [
    copy.labels.seller,
    SELLER.name,
    ...SELLER.address,
    `${locale === 'de' ? 'Geschäftsführer' : 'Managing Director'}: ${SELLER.managingDirector}`,
    SELLER.register,
    `USt-IdNr./VAT ID: ${SELLER.vatId}`,
    `${SELLER.email} · ${SELLER.phone}`,
  ];
}

function buildSections({ kind, order, orderItems, shipments, shipment, noticeAmountCents, locale, copy }) {
  const labels = copy.labels;
  const allItems = kind === 'shipment_confirmation' && shipment
    ? orderItems.filter((item) => Number(item.shipment_index) === Number(shipment.shipment_index))
    : orderItems;
  const items = allItems.map((item) => itemView(item, locale));
  const metadata = [
    `${labels.order}: ${orderNumber(order)}`,
    `${labels.date}: ${dateTime(order.paid_at || order.created_at, locale)}`,
    `${labels.buyer}: ${order.buyer_email || '—'}`,
  ];
  const itemLines = [labels.items, ...items.map((item) => (
    `${item.quantity} × ${item.name}${item.size ? ` · ${item.size}` : ''} · ` +
    `${labels.variant}: ${item.variant} · ${labels.design}: ${item.design}`
  ))];
  const sections = [metadata, itemLines];

  if (kind === 'order_confirmation') {
    sections.push([
      labels.deliveries,
      ...shipments.flatMap((entry, index) => [
        `${labels.delivery} ${index + 1}`,
        ...addressLines(entry.recipient_json, locale),
      ]),
    ]);
    sections.push([
      `${labels.itemSubtotal}: ${money(order.items_cents, order.currency, locale)}`,
      `${labels.shipping}: ${money(order.shipping_cents, order.currency, locale)}`,
      `${labels.tax}: ${money(order.tax_cents, order.currency, locale)}`,
      `${labels.total}: ${money(order.total_cents, order.currency, locale)}`,
    ]);
    sections.push([
      labels.contract,
      copy.contract,
      copy.personalization,
      `${labels.version}: ${CONTRACT_VERSION}`,
    ]);
  } else if (kind === 'shipment_confirmation' && shipment) {
    sections.push([
      `${labels.shipment}: ${Number(shipment.shipment_index) + 1}`,
      `${labels.carrier}: ${shipment.carrier || '—'}`,
      `${labels.trackingNumber}: ${shipment.tracking_number || '—'}`,
      shipment.tracking_url ? `${labels.tracking}: ${shipment.tracking_url}` : copy.trackingMissing,
    ]);
  } else if (kind === 'refund_confirmation') {
    sections.push([
      `${labels.refund}: ${money(noticeAmountCents ?? order.refunded_cents ?? order.total_cents, order.currency, locale)}`,
      `${labels.total}: ${money(order.total_cents, order.currency, locale)}`,
    ]);
  }
  sections.push(sellerLines(locale, copy));
  sections.push([interpolate(copy.support, { email: SELLER.email })]);
  return sections;
}

function renderText(copy, intro, sections) {
  return [copy.greeting, '', intro, '', ...sections.flatMap((section) => [...section, ''])]
    .join('\n').trim() + '\n';
}

function renderHtml(copy, intro, sections) {
  const sectionHtml = sections.map((section) => {
    const [first, ...rest] = section;
    const hasHeading = rest.length > 0;
    return `<section style="margin:24px 0">${hasHeading ? `<h2 style="font-size:17px;margin:0 0 8px">${escapeHtml(first)}</h2>` : ''}` +
      `<div style="white-space:pre-line;line-height:1.55">${(hasHeading ? rest : section).map(htmlLine).join('<br>')}</div></section>`;
  }).join('');
  return '<!doctype html><html><body style="margin:0;background:#f7f4f0;color:#241f20;font-family:Arial,sans-serif">' +
    '<main style="max-width:680px;margin:0 auto;padding:32px 20px;background:#fff">' +
    '<h1 style="color:#a40e4c;font-size:28px;margin:0 0 24px">Wolkenworte</h1>' +
    `<p>${escapeHtml(copy.greeting)}</p><p style="line-height:1.55">${escapeHtml(intro)}</p>${sectionHtml}` +
    '</main></body></html>';
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
  if (!copy.subjects[kind] || !copy.intros[kind]) throw new Error('unsupported transactional email kind');
  const number = orderNumber(order);
  const isTestOrder = order?.mode === 'test' || order?.status === 'paid_test';
  const sections = buildSections({
    kind, order, orderItems, shipments, shipment, noticeAmountCents,
    locale: normalizedLocale, copy,
  });
  return {
    locale: normalizedLocale,
    templateVersion: TEMPLATE_VERSION,
    subject: (isTestOrder ? '[TEST] ' : '') + interpolate(copy.subjects[kind], { number }),
    textBody: renderText(copy, isTestOrder ? `${copy.testNotice}\n\n${copy.intros[kind]}` : copy.intros[kind], sections),
    htmlBody: renderHtml(copy, isTestOrder ? `${copy.testNotice} ${copy.intros[kind]}` : copy.intros[kind], sections),
  };
}

module.exports = {
  TEMPLATE_VERSION,
  CONTRACT_VERSION,
  SELLER,
  orderNumber,
  buildEmailSnapshot,
};
