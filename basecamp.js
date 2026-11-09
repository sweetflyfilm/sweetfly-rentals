/* One card per product family; selection changes only the reference image and details. */
const tentVariants = {
  open: { image: '/images/field-village-canopy.png', alt: 'Eurmax 10 by 10 foot open canopy tent', rate: '$35 / day', details: 'Open 10 × 10 ft canopy. One available.' },
  covered: { image: '/images/tent-10x10-covered.jpg?v=20261109-grant-photo', alt: 'Eurmax 10 by 10 foot canopy with sidewalls', rate: '$35 / day', details: 'Covered 10 × 10 ft canopy with sidewall enclosure. One available.' },
  large: { image: '/images/tent-10x20.jpg', alt: 'Eurmax 10 by 20 foot open canopy tent', rate: 'Contact Us for rate', details: 'Larger 10 × 20 ft canopy. One available. Swap it into the Basecamp package for +$20 / day ($130 / day total).' },
};
const tableVariants = {
  six: { image: '/images/field-village-tables.png', alt: 'Lifetime 6 foot almond folding table', details: '6 ft almond folding table. One available. The 8 ft table is also available separately.' },
  eight: { image: '/images/table-8ft.jpg', alt: 'Lifetime 8 foot almond folding table', details: '8 ft almond folding table. One available. The 6 ft table is also available separately.' },
};

function bindVariant(selectId, imageId, detailsId, variants, rateId) {
  const select = document.getElementById(selectId);
  const image = document.getElementById(imageId);
  const details = document.getElementById(detailsId);
  if (!select || !image || !details) return;
  const paint = () => {
    const variant = variants[select.value];
    if (!variant) return;
    image.src = variant.image;
    image.alt = variant.alt;
    image.classList.toggle('basecamp-reference-photo', variant.image.split('?')[0].endsWith('.jpg'));
    details.textContent = variant.details;
    if (rateId) document.getElementById(rateId).textContent = variant.rate;
  };
  select.addEventListener('change', paint);
  paint();
}

bindVariant('tentVariant', 'tentImage', 'tentDetails', tentVariants, 'tentRate');
bindVariant('tableVariant', 'tableImage', 'tableDetails', tableVariants);
