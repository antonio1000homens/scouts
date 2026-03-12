#!/usr/bin/env node

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: 'eu-west-2' });
const BUCKET = '2ndtolworth';
const PREFIX = 'events/';

async function findModelFiles() {
  let continuationToken = undefined;
  const modelFiles = [];

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

        if (data.title && data.title.toLowerCase().includes('model')) {
          modelFiles.push({ key, title: data.title, hex: data.hex });
        }
      } catch (error) {
        console.error(`Error processing ${key}:`, error.message);
      }
    }

    continuationToken = response?.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`Found ${modelFiles.length} files with "model" in title:`);
  modelFiles.forEach(file => {
    console.log(`Key: ${file.key}`);
    console.log(`Title: "${file.title}"`);
    console.log(`Hex: ${file.hex || 'not set'}`);
    console.log('---');
  });
}

findModelFiles().catch(console.error);