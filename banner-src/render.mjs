// Баннер infra-site-template: `node banner-src/render.mjs`.
// Playwright берётся из соседнего клона infra-site-template, там он стоит для e2e.
// Баннер профиля не верстается, он сгенерирован в nanobanana.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const assets = path.resolve(dir, '../assets')
const workspace = path.resolve(dir, '../..')

const require = createRequire(path.join(workspace, 'infra-site-template/package.json'))
const { chromium } = require('playwright')

// В репозиториях русский баннер называется `banner.jpg`, английский -- `banner.en.jpg`.
const suffix = { ru: '', en: '.en' }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 2560, height: 960 } })

for (const lang of ['en', 'ru']) {
	await page.goto(`file://${dir}/template.html?lang=${lang}`)
	await page.evaluate(() => document.fonts.ready)
	await page.waitForTimeout(300)
	await page.screenshot({
		path: path.join(assets, `infra-site-template${suffix[lang]}.jpg`),
		type: 'jpeg',
		quality: 92,
	})
}

await browser.close()
