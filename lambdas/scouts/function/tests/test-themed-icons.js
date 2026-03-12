#!/usr/bin/env node

/**
 * Test the themed icon matching function with various event names
 */

// Simulate the function from scouts.mjs
const DEFAULT_OSM_CDN_BASE_URL = 'https://oymcdn.co.uk';

function resolveOsmCdnBaseUrl() {
  return DEFAULT_OSM_CDN_BASE_URL;
}

function getOsmThemedIcon(eventName) {
  if (!eventName) {
    return `${resolveOsmCdnBaseUrl()}/ext/mymember/dashboard/images/global.jpg`;
  }

  const name = eventName.toLowerCase();

  const themes = [
    { pattern: /agm|annual.*general|general.*meeting/i, icon: 'agm' },
    { pattern: /firework|bonfire/i, icon: 'fireworks' },
    { pattern: /sleepover|sleep.*over|camp(?!fire)/i, icon: 'sleepover' },
    { pattern: /party|celebration/i, icon: 'party' },
    { pattern: /christmas|xmas/i, icon: 'xmas' },
    { pattern: /night.*hike|hike.*night/i, icon: 'nighthike' },
    { pattern: /laser|laser.*tag|laser.*quest/i, icon: 'lasertag' },
    { pattern: /expedition|trip|journey/i, icon: 'expedition' },
    { pattern: /sailing|boat/i, icon: 'sailing' },
    { pattern: /campfire|fire/i, icon: 'fire' },
    { pattern: /golf/i, icon: 'golf' },
    { pattern: /church|service/i, icon: 'church' },
    { pattern: /remembrance|poppy/i, icon: 'remembrance' },
    { pattern: /dragon|den/i, icon: 'dragonden' },
    { pattern: /reading|book/i, icon: 'bookreader' },
    { pattern: /hike|hiking|walk/i, icon: 'nighthike' },
    { pattern: /swim/i, icon: 'sailing' },
  ];

  const cdnBase = resolveOsmCdnBaseUrl();

  for (const { pattern, icon } of themes) {
    if (pattern.test(name)) {
      return `${cdnBase}/ext/mymember/dashboard/images/${icon}.jpg`;
    }
  }

  return `${cdnBase}/ext/mymember/dashboard/images/global.jpg`;
}

console.log('🎨 Testing OSM Themed Icon Matching\n');
console.log('='.repeat(80));

const testEvents = [
  'Annual General Meeting',
  '4T fireworks night',
  'Sleepover',
  'Christmas Party',
  'Summer Hike',
  'Laser Quest',
  'Surbiton Parade',
  'Night Hike',
  'Campfire and Sparklers',
  'Remembrance Day',
  'Golf Tournament',
  'Book Reading',
  'Dragon Den',
  'Swimming Gala',
  'Random Event Name',
  null,
];

testEvents.forEach(eventName => {
  const icon = getOsmThemedIcon(eventName);
  const iconName = icon.split('/').pop();
  console.log(`\n📅 "${eventName || '(null)'}"`);
  console.log(`   → ${iconName}`);
  console.log(`   🔗 ${icon}`);
});

console.log('\n' + '='.repeat(80));
console.log('✅ Themed icon matching test complete!\n');
