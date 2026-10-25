// Сверяет профильный README с аккаунтом.
// Запуск: `node scripts/check-profile.mjs [--report report.md]`.
//
// Баннеры и бейджи подтягиваются по ссылкам сами. Ловим то, что само не обновится:
// новый репо без карточки, битую ссылку на баннер или workflow, разошедшиеся EN и RU.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(path.join(root, 'profile.json'), 'utf8'))
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

const errors = []
const warnings = []

async function github(url) {
	const res = await fetch(`https://api.github.com${url}`, {
		headers: {
			accept: 'application/vnd.github+json',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
	})

	if (res.status === 404) return null

	if (!res.ok) throw new Error(`GitHub ${url}: ${res.status} ${await res.text()}`)

	return res.json()
}

async function ownRepos(owner) {
	const repos = []

	for (let page = 1; ; page++) {
		const batch = await github(`/users/${owner}/repos?type=owner&per_page=100&page=${page}`)

		repos.push(...batch)

		if (batch.length < 100) break
	}

	return repos.filter((repo) => !repo.private && !repo.fork && !repo.archived).map((repo) => repo.name)
}

// Страницы GitHub вида github.com/<раздел>/<страница>, а не репо.
const notOwners = new Set(['features', 'sponsors', 'orgs', 'settings', 'topics', 'marketplace', 'apps', 'collections'])

/**
 * Ключ картинки без языка: у переводов свой баннер (`banner.jpg` против `banner.en.jpg`)
 * и своя подпись бейджа сайта, а показывать они должны одно и то же.
 */
function imageKey(src) {
	if (src.startsWith('https://img.shields.io/website')) return `site:${new URL(src).searchParams.get('url')}`

	return src.replace(/\.en\.(jpg|png)$/, '.$1')
}

/** Всё, на что ссылается README: репо из ссылок, картинки и файлы workflow из бейджей. */
function parse(file) {
	const text = readFileSync(path.join(root, file), 'utf8')
	const repos = new Set()
	const images = new Map()
	const workflows = new Set()

	for (const [, owner, repo] of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)(?=["/#?)])/g)) {
		if (!notOwners.has(owner)) repos.add(`${owner}/${repo}`)
	}

	for (const [, src] of text.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) {
		if (!src.startsWith('https://img.shields.io/badge/')) images.set(imageKey(src), src)
	}

	for (const [, owner, repo, file] of text.matchAll(/github\/actions\/workflow\/status\/([\w.-]+)\/([\w.-]+)\/([\w.-]+\.ya?ml)/g)) {
		workflows.add(`${owner}/${repo}/${file}`)
	}

	for (const [, owner, repo, file] of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/workflows\/([\w.-]+\.ya?ml)/g)) {
		workflows.add(`${owner}/${repo}/${file}`)
	}

	return { repos, images, workflows }
}

const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x))
const list = (items) => [...items].sort().map((x) => `\`${x}\``).join(', ')

const parsed = Object.fromEntries(config.readmes.map((file) => [file, parse(file)]))
const [main, ...translations] = config.readmes

// Переводы должны показывать те же проекты и те же картинки, иначе один язык отстал.
for (const file of translations) {
	for (const key of ['repos', 'images']) {
		const a = new Set(parsed[main][key].keys())
		const b = new Set(parsed[file][key].keys())

		if (!same(a, b)) {
			const onlyMain = [...a].filter((x) => !b.has(x))
			const onlyTranslation = [...b].filter((x) => !a.has(x))

			errors.push(
				`${main} and ${file} differ in ${key}: only in ${main}: ${list(onlyMain) || '—'}; only in ${file}: ${list(onlyTranslation) || '—'}`,
			)
		}
	}
}

const shown = new Set(
	[...parsed[main].repos].filter((r) => r.startsWith(`${config.owner}/`)).map((r) => r.split('/')[1]),
)
const hidden = new Set(config.hidden)
const todo = new Set(config.todo)
const repos = await ownRepos(config.owner)

for (const name of repos) {
	if (shown.has(name) || hidden.has(name)) continue

	if (todo.has(name)) warnings.push(`\`${config.owner}/${name}\` is not in the profile yet (listed in \`todo\`)`)
	else errors.push(`\`${config.owner}/${name}\` is public but neither in the profile nor in \`hidden\` or \`todo\``)
}

for (const name of todo) {
	if (shown.has(name)) errors.push(`\`${name}\` is in the profile now: remove it from \`todo\``)
}

for (const name of [...hidden, ...todo]) {
	if (!repos.includes(name)) warnings.push(`\`${name}\` from profile.json is no longer a public repo of ${config.owner}`)
}

// Репо, на которые ведут карточки: живы и не в архиве.
for (const full of parsed[main].repos) {
	const repo = await github(`/repos/${full}`)

	if (!repo) errors.push(`\`${full}\` is linked but not found`)
	else if (repo.archived) errors.push(`\`${full}\` is linked but archived`)
}

// Картинки проверяем во всех языках: битым может оказаться только русский баннер.
for (const src of new Set(Object.values(parsed).flatMap((p) => [...p.images.values()]))) {
	if (src.startsWith('https://img.shields.io/')) continue

	if (/^https?:/.test(src)) {
		const res = await fetch(src, { method: 'HEAD' })

		if (!res.ok) errors.push(`image ${src} answers ${res.status}`)
	} else if (!existsSync(path.join(root, src))) {
		errors.push(`image \`${src}\` is missing from the repo`)
	}
}

// Бейдж на несуществующий workflow тихо показывает "no status", поэтому проверяем файл.
for (const entry of new Set([...Object.values(parsed).flatMap((p) => [...p.workflows])])) {
	const [owner, repo, file] = entry.split('/')

	if (!(await github(`/repos/${owner}/${repo}/contents/.github/workflows/${file}`))) {
		errors.push(`workflow \`${entry}\` from a badge does not exist`)
	}
}

const lines = [
	'## Profile README drift',
	'',
	...(errors.length ? ['**Out of date:**', '', ...errors.map((e) => `- ${e}`), ''] : []),
	...(warnings.length ? ['**Still to do:**', '', ...warnings.map((w) => `- ${w}`), ''] : []),
	...(errors.length || warnings.length ? [] : ['Everything matches.', '']),
]
const report = lines.join('\n')

console.log(report)

const reportArg = process.argv.indexOf('--report')

if (reportArg !== -1) writeFileSync(process.argv[reportArg + 1], report)

if (process.env.GITHUB_OUTPUT) {
	writeFileSync(process.env.GITHUB_OUTPUT, `drift=${errors.length || warnings.length ? 'true' : 'false'}\n`, {
		flag: 'a',
	})
}

process.exitCode = errors.length ? 1 : 0
