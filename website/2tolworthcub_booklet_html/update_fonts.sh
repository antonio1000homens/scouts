#!/bin/bash

# Update index.html
sed -i "s|font-family: 'Nunito Sans', -apple-system|font-family: 'Nunito Sans', -apple-system|g" index.html
sed -i '/<title>/a\<link rel="stylesheet" href="../fonts/fonts.css">' index.html

# Update all page files
for i in {1..9}; do
  if [ -f "page${i}.html" ]; then
    sed -i "s|font-family: 'Nunito Sans', -apple-system|font-family: 'Nunito Sans', -apple-system|g" "page${i}.html"
    sed -i '/<title>/a\<link rel="stylesheet" href="../fonts/fonts.css">' "page${i}.html"
  fi
done

echo "Updated fonts in all booklet pages"
