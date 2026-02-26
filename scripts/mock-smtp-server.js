const fs = require("node:fs/promises");
const path = require("node:path");
const { SMTPServer } = require("smtp-server");

const host = process.env.MOCK_SMTP_HOST || "127.0.0.1";
const port = Number(process.env.MOCK_SMTP_PORT || 1026);
const outDir =
  process.env.MOCK_SMTP_OUT_DIR || path.join(__dirname, "..", "data", "mock-smtp");

let counter = 0;

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on("end", async () => {
        try {
          counter += 1;
          const raw = Buffer.concat(chunks);
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const emlFile = path.join(outDir, `${stamp}-${counter}.eml`);
          const metaFile = path.join(outDir, `${stamp}-${counter}.json`);
          await fs.writeFile(emlFile, raw);
          await fs.writeFile(
            metaFile,
            JSON.stringify(
              {
                receivedAt: new Date().toISOString(),
                envelope: session.envelope,
                remoteAddress: session.remoteAddress,
                hostNameAppearsAs: session.hostNameAppearsAs,
                emlFile: path.basename(emlFile)
              },
              null,
              2
            ),
            "utf8"
          );
          console.log(`Mock SMTP: saved ${path.basename(emlFile)}`);
          callback();
        } catch (error) {
          callback(error);
        }
      });
      stream.on("error", callback);
    }
  });

  server.on("error", (err) => {
    console.error(`Mock SMTP error: ${String(err)}`);
  });

  server.listen(port, host, () => {
    console.log(`Mock SMTP listening on smtp://${host}:${port}`);
    console.log(`Saved messages in: ${outDir}`);
  });
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
