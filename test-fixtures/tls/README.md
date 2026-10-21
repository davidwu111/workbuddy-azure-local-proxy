# Public offline TLS fixture

The certificate and private key in this directory are synthetic, publicly committed test data. **Never use them for a real service.** The certificate only covers loopback IPs (127.0.0.1, 127.0.0.2, ::1); tests explicitly trust this certificate rather than disabling verification.

Generated on 2026-10-21 with OpenSSL, valid for 3650 days:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout localhost-key.pem -out localhost-cert.pem -days 3650 \
  -subj '/CN=azure-bridge-offline-fixture' \
  -addext 'subjectAltName=IP:127.0.0.1,IP:127.0.0.2,IP:::1'
```

The [unrelated key](<unrelated-key.pem>) was generated with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` and is intentionally incompatible with the [loopback certificate](<localhost-cert.pem>) for key-mismatch regression coverage. It is also public synthetic test data.

There is no Azure credential or deployment certificate in this fixture.
