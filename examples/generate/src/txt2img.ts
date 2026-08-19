import { v4 as uuidv4 } from 'uuid';

import { ComfyUIClient } from 'comfy-ui-client';
import type { Prompt } from 'comfy-ui-client';

// The ComfyUI server address. May include a scheme (https://, wss://).
const SERVER_ADDRESS = '127.0.0.1:8188';

export const txt2img = async (
  prompt: Prompt,
  outputDir: string,
): Promise<void> => {
  // Create client ID
  const clientId = uuidv4();

  // Optional third argument:
  // new ComfyUIClient(SERVER_ADDRESS, clientId, {
  //   apiToken: '...',        // multi-user servers (Bearer auth)
  //   requestTimeoutMs: 60000,
  //   logger: console,        // inject your own logger
  // });
  const client = new ComfyUIClient(SERVER_ADDRESS, clientId);

  try {
    await client.connect();

    // Wait for the prompt to finish, with progress reporting and a timeout.
    // Rejects on execution_error / interrupted / disconnect / timeout
    // instead of hanging forever.
    const images = await client.getImages(prompt, {
      timeoutMs: 10 * 60_000,
      onProgress: (p) => console.log(`progress: ${p.value}/${p.max}`),
      onExecuting: (d) => {
        if (d.node) console.log(`executing node ${d.node}`);
      },
    });

    // Save images to file
    await client.saveImages(images, outputDir);
  } finally {
    // Disconnect
    client.disconnect();
  }
};
