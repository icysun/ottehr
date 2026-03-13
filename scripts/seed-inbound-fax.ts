/**
 * Seeds a fake inbound fax for local UI testing.
 *
 * Usage:
 *   npx tsx scripts/seed-inbound-fax.ts /path/to/some.pdf
 */

import Oystehr from '@oystehr/sdk';
import { readFileSync } from 'fs';
import { DateTime } from 'luxon';

const config = {
  AUTH0_ENDPOINT: 'https://auth.zapehr.com/oauth/token',
  AUTH0_AUDIENCE: 'https://api.zapehr.com',
  AUTH0_CLIENT: 'FKGL4BydF7LEDZo7eun9TeKM9UhFpj4B',
  AUTH0_SECRET: 'F7nVC0YM9mioFQxNpvbaQ_Ao3gTnnQi0YYUs5-zXIlTdnCJEugBIxEK8Bj5VYtvn',
  FHIR_API: 'https://fhir-api.zapehr.com/r4',
  PROJECT_API: 'https://project-api.zapehr.com/v1',
  PROJECT_ID: '0ba6d7a5-a5a6-4c16-a6d9-ce91f300acb4',
};

const SENDER_FAX_NUMBER = '+15551234567';
const FAX_PAGES = 3;

async function getM2MToken(): Promise<string> {
  const response = await fetch(config.AUTH0_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: config.AUTH0_CLIENT,
      client_secret: config.AUTH0_SECRET,
      audience: config.AUTH0_AUDIENCE,
    }),
  });
  const json = await response.json();
  if (!json.access_token) {
    throw new Error(`Failed to get token: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function main(): Promise<void> {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: npx tsx scripts/seed-inbound-fax.ts <path-to-pdf>');
    process.exit(1);
  }

  console.log('Getting M2M token...');
  const token = await getM2MToken();

  const oystehr = new Oystehr({
    accessToken: token,
    fhirApiUrl: config.FHIR_API,
    projectApiUrl: config.PROJECT_API,
  });

  // 1. Upload PDF to Z3 (fax-received bucket)
  const fileName = `test-fax-${DateTime.now().toFormat('yyyy-MM-dd-x')}.pdf`;
  // Using 'labs' bucket since 'fax-received' bucket doesn't exist in this project
  const z3Url = `${config.PROJECT_API}/z3/${config.PROJECT_ID}-labs/inbound-fax/${fileName}`;

  console.log(`Uploading PDF to Z3: ${z3Url}`);

  // Get presigned upload URL
  const presignedResponse = await fetch(z3Url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'upload' }),
  });

  if (!presignedResponse.ok) {
    const text = await presignedResponse.text();
    throw new Error(`Failed to get presigned URL: ${presignedResponse.status} ${text}`);
  }

  const { signedUrl } = await presignedResponse.json();

  // Upload the PDF
  const pdfBytes = readFileSync(pdfPath);
  const uploadResponse = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBytes,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload PDF: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }
  console.log('PDF uploaded successfully');

  // 2. Create Communication resource (simulating inbound fax)
  const now = DateTime.now().toISO();
  const communication = await oystehr.fhir.create({
    resourceType: 'Communication',
    status: 'completed',
    contained: [
      {
        resourceType: 'Device',
        id: SENDER_FAX_NUMBER,
        deviceName: [{ name: SENDER_FAX_NUMBER, type: 'user-friendly-name' }],
      },
    ],
    medium: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationMode',
            code: 'FAXWRIT',
            display: 'telefax',
          },
        ],
      },
    ],
    sender: {
      reference: `#${SENDER_FAX_NUMBER}`,
    },
    received: now,
    sent: now,
    payload: [
      {
        contentAttachment: {
          url: z3Url,
          contentType: 'application/pdf',
          title: fileName,
        },
      },
    ],
    extension: [
      {
        url: 'https://extensions.fhir.oystehr.com/fax-pages',
        valueInteger: FAX_PAGES,
      },
      {
        url: 'https://extensions.fhir.oystehr.com/inbound-fax-status',
        valueString: 'received',
      },
    ],
  });

  console.log(`Created Communication/${communication.id}`);

  // 3. Create Task (as the subscription zambda would)
  const task = await oystehr.fhir.create({
    resourceType: 'Task',
    status: 'ready',
    intent: 'order',
    description: `Inbound fax from ${SENDER_FAX_NUMBER} (${FAX_PAGES} pages)`,
    authoredOn: now,
    groupIdentifier: {
      system: 'https://fhir.ottehr.com/Identifier/task-category',
      value: 'inbound-fax',
    },
    code: {
      coding: [
        {
          system: 'inbound-fax-task',
          code: 'match-inbound-fax',
        },
      ],
    },
    basedOn: [{ reference: `Communication/${communication.id}` }],
    input: [
      {
        type: {
          coding: [{ system: 'https://fhir.ottehr.com/CodeSystem/task-input', code: 'sender-fax-number' }],
        },
        valueString: SENDER_FAX_NUMBER,
      },
      {
        type: {
          coding: [{ system: 'https://fhir.ottehr.com/CodeSystem/task-input', code: 'page-count' }],
        },
        valueString: String(FAX_PAGES),
      },
      {
        type: {
          coding: [{ system: 'https://fhir.ottehr.com/CodeSystem/task-input', code: 'communication-id' }],
        },
        valueString: communication.id,
      },
      {
        type: {
          coding: [{ system: 'https://fhir.ottehr.com/CodeSystem/task-input', code: 'pdf-url' }],
        },
        valueString: z3Url,
      },
      {
        type: {
          coding: [{ system: 'https://fhir.ottehr.com/CodeSystem/task-input', code: 'received-date' }],
        },
        valueString: now,
      },
    ],
    meta: {
      tag: [{ code: 'task' }],
    },
  });

  console.log(`Created Task/${task.id}`);
  console.log('');
  console.log('Test fax seeded successfully!');
  console.log(`  Communication ID: ${communication.id}`);
  console.log(`  Task ID: ${task.id}`);
  console.log(`  Match URL: http://localhost:4002/inbound-fax/${communication.id}/match`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
