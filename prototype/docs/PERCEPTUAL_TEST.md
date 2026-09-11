# Perceptual test protocol (Hidden envelope)

Automated metrics (PSNR / SSIM / CIEDE2000) are **proxies**, not proof of
invisibility. They can pass while a careful observer still notices a difference
under magnification, unusual lighting, or contrast enhancement.

## Release gate (manual)

Hidden envelope must **not** be labelled production-ready until a randomized,
double-blind A/B test at **normal phone viewing size** shows that at least
**20 participants** perform **no better than chance** within the study’s
confidence interval when distinguishing clean vs encoded carriers.

### Suggested procedure

1. Prepare N pairs (N ≥ 40) of clean vs encoded envelope images at the same
   display size used in performance (full-viewport fit, no zoom).
2. Randomize order and left/right (or sequential A/B) presentation.
3. Ask: “Are these the same photo, or is one altered?” (or forced choice).
4. Record accuracy, display model, brightness, and viewing distance (~30–40 cm).
5. Compute binomial confidence interval vs chance; require performance consistent
   with chance for the release claim.

Store aggregate counts only (no participant PII) under `prototype/test-results/`.

This gate is **not** implemented as a unit test.
