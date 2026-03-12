#!/usr/bin/env node

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'eu-west-2' });
const BUCKET = '2ndtolworth';
const PREFIX = 'events/';

async function findDuplicateTitles() {
  let continuationToken = undefined;
  const titleMap = new Map();

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: PREFIX,
      ContinuationToken: continuationToken,
    });
    
    const response = await s3.send(listCommand);
    const objects = response?.Contents || [];

    for (const object of objects) {
      const key = object?.Key;
      if (!key || !key.endsWith('.json')) continue;

      try {
        const getCommand = new GetObjectCommand({ Bucket: BUCKET, Key: key });
        const getResponse = await s3.send(getCommand);
        const bodyString = await getResponse.Body.transformToString();
        const data = JSON.parse(bodyString);

        if (data.title) {
          const title = data.title.toLowerCase();
          if (!titleMap.has(title)) {
            titleMap.set(title, []);
          }
          titleMap.get(title).push({ key, data });
        }
      } catch (error) {
        console.error(`Error processing ${key}:`, error.message);
      }
    }

    continuationToken = response?.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  // Find "model making" files
  const modelMakingFiles = titleMap.get('model making') || [];
  
  console.log(`Found ${modelMakingFiles.length} files with title "Model making":`);
  for (const file of modelMakingFiles) {
    console.log(`\nKey: ${file.key}`);
    console.log(`Title: ${file.data.title}`);
    console.log(`Hex: ${file.data.hex || 'not set'}`);
    console.log(`AI: ${file.data.AI ? 'present' : 'null'}`);
    console.log(`Image URL: ${file.data.image?.url || 'null'}`);
    console.log(`Image Prompt: ${file.data.image?.prompt || 'null'}`);
  }

  // Show all duplicates
  console.log('\n--- All duplicate titles ---');
  for (const [title, files] of titleMap.entries()) {
    if (files.length > 1) {
      console.log(`\n"${title}": ${files.length} files`);
      files.forEach(file => console.log(`  - ${file.key}`));
    }
  }
}

findDuplicateTitles().catch(console.error);