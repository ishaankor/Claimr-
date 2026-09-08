import { CONFIG } from './config.js';

function resolveProductSlug(element) {
  const homeMapping = element.offerMappings?.find(m => m.pageType === 'productHome' && m.pageSlug);
  if (homeMapping?.pageSlug) return homeMapping.pageSlug;

  const anyMapping = element.offerMappings?.find(m => m.pageSlug);
  if (anyMapping?.pageSlug) return anyMapping.pageSlug;

  const catalogMapping = element.catalogNs?.mappings?.find(m => m.pageSlug);
  if (catalogMapping?.pageSlug) return catalogMapping.pageSlug;

  if (element.productSlug && element.productSlug !== '[]') return element.productSlug;
  if (element.urlSlug) return element.urlSlug;

  return null;
}

export async function getPromotions() {
  const url = `${CONFIG.EPIC_FREE_PROMOTIONS_URL}?locale=${CONFIG.LOCALE}&country=${CONFIG.COUNTRY}&allowCountries=${CONFIG.COUNTRY}`;
  
  const res = await fetch(url, {
    headers: {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch promotions from Epic Games API: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const elements = json?.data?.Catalog?.searchStore?.elements || [];
  const now = new Date();

  const currentFreeGames = [];
  const upcomingFreeGames = [];

  for (const el of elements) {
    const title = el.title;
    const id = el.id;
    const namespace = el.namespace;
    const slug = resolveProductSlug(el);
    const storeUrl = slug ? `${CONFIG.EPIC_STORE_URL}/${CONFIG.LOCALE}/p/${slug}` : null;
    const thumbnail = el.keyImages?.find(img => img.type === 'Thumbnail' || img.type === 'OfferImageWide')?.url 
      || el.keyImages?.[0]?.url 
      || null;

    const promo = el.promotions;
    if (!promo) continue;

    const currentOffers = promo.promotionalOffers || [];
    let activeOffer = null;
    for (const group of currentOffers) {
      for (const offer of (group.promotionalOffers || [])) {
        const start = new Date(offer.startDate);
        const end = new Date(offer.endDate);
        if (start <= now && now <= end && (offer.discountSetting?.discountPercentage === 0 || offer.discountSetting?.discountPrice === 0)) {
          activeOffer = { start, end };
          break;
        }
      }
      if (activeOffer) break;
    }

    if (activeOffer) {
      currentFreeGames.push({
        id,
        title,
        namespace,
        slug,
        storeUrl,
        thumbnail,
        startDate: activeOffer.start.toISOString(),
        endDate: activeOffer.end.toISOString(),
      });
      continue;
    }

    const upcomingOffers = promo.upcomingPromotionalOffers || [];
    let nextOffer = null;
    for (const group of upcomingOffers) {
      for (const offer of (group.promotionalOffers || [])) {
        const start = new Date(offer.startDate);
        const end = new Date(offer.endDate);
        if (start > now && (offer.discountSetting?.discountPercentage === 0 || offer.discountSetting?.discountPrice === 0)) {
          nextOffer = { start, end };
          break;
        }
      }
      if (nextOffer) break;
    }

    if (nextOffer) {
      upcomingFreeGames.push({
        id,
        title,
        namespace,
        slug,
        storeUrl,
        thumbnail,
        startDate: nextOffer.start.toISOString(),
        endDate: nextOffer.end.toISOString(),
      });
    }
  }

  return {
    currentFreeGames,
    upcomingFreeGames,
  };
}
