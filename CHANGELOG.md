# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]



## [1.6.6] - 2026-01-08

### 🐛 Fixed

- **database-clean**: dependence ([#344](https://github.com/tegojs/tego-standard/pull/344)) (@TomyJan)

## [1.6.5] - 2026-01-08

### ✨ Added

- **cron**: add distributed lock for cron job execution ([#337](https://github.com/tegojs/tego-standard/pull/337)) (@TomyJan)

### 🐛 Fixed

- **multi-app**: wrong ctx ([#336](https://github.com/tegojs/tego-standard/pull/336)) (@TomyJan)

## [1.6.4] - 2025-12-26

### 🐛 Fixed

- **module-auth**: token removal to avoid SQL IN (NULL) issue ([#332](https://github.com/tegojs/tego-standard/pull/332)) (@TomyJan)

## [1.6.2] - 2025-12-22

### ✨ Added

- **plugin-database-clean**: db clean ([#238](https://github.com/tegojs/tego-standard/pull/238)) (@TomyJan)
- **module-error-handler**: translation of jwt expire and permission denied ([#325](https://github.com/tegojs/tego-standard/pull/325)) (@TomyJan)
- add deprecation warning for legacy commands ([#317](https://github.com/tegojs/tego-standard/pull/317)) (@TomyJan)

### 🐛 Fixed

- missing plugin metadata ([#324](https://github.com/tegojs/tego-standard/pull/324)) (@TomyJan)
- missing plugin metadata ([#323](https://github.com/tegojs/tego-standard/pull/323)) (@TomyJan)
- repo url ([#321](https://github.com/tegojs/tego-standard/pull/321)) (@TomyJan)
- **workflow-approval**: fixed workflow not found when workflow is revision ([#320](https://github.com/tegojs/tego-standard/pull/320)) (@bai.zixv)

### 🔄 Changed

- **module-auth**: move user status control to core ([#263](https://github.com/tegojs/tego-standard/pull/263)) (@TomyJan)
- disable lazy compilation ([#322](https://github.com/tegojs/tego-standard/pull/322)) (@TomyJan)

## [1.6.1] - 2025-12-05

### ✨ Added

- core update ([#295](https://github.com/tegojs/tego-standard/pull/295)) (@TomyJan)
- **module-workflow**: support sub-workflow trigger, source mapping and properties mapping ([#314](https://github.com/tegojs/tego-standard/pull/314)) (@bai.zixv)
- **workflow**: support sync remote code ([#292](https://github.com/tegojs/tego-standard/pull/292)) (@bai.zixv)
- **cloud-component**: support remote code ([#290](https://github.com/tegojs/tego-standard/pull/290)) (@bai.zixv)
- mobile pagination and translation ([#294](https://github.com/tegojs/tego-standard/pull/294)) (@dududuna)
- **desktop**: support desktop app & chore(cursor): update cursor rules ([#293](https://github.com/tegojs/tego-standard/pull/293)) (@bai.zixv)
- add select node ([#286](https://github.com/tegojs/tego-standard/pull/286)) (@dududuna)
- **workflow**: add enabled toggle to workflow and webhook ([#287](https://github.com/tegojs/tego-standard/pull/287)) (@bai.zixv)

### 🐛 Fixed

- **module-workflow**: fix TriggerInstruction compatibility (@bai.zixv)
- **module-workflow&module-cloud-component**: fixed remote code fetching cache ([#313](https://github.com/tegojs/tego-standard/pull/313)) (@bai.zixv)
- **workflow-approval**: fixed cleanAssociationIds ([#311](https://github.com/tegojs/tego-standard/pull/311)) (@bai.zixv)
- workflow select component (@bai.zixv)
- remote script code sync time (@bai.zixv)
- script instruction code editor type (@bai.zixv)
- **cloud-component & workflow**: fix remote code fetching logic ([#308](https://github.com/tegojs/tego-standard/pull/308)) (@bai.zixv)
- **client**: fix code mirror component ([#309](https://github.com/tegojs/tego-standard/pull/309)) (@bai.zixv)
- **desktop & workflow**: fix monaco editor loading error ([#307](https://github.com/tegojs/tego-standard/pull/307)) (@bai.zixv)
- setting conditions for approval data range on mobile devices ([#304](https://github.com/tegojs/tego-standard/pull/304)) (@dududuna)
- single line text in the table with invalid counterpart method ([#303](https://github.com/tegojs/tego-standard/pull/303)) (@dududuna)
- incorrect label style ([#298](https://github.com/tegojs/tego-standard/pull/298)) (@dududuna)
- modify approval field title ([#299](https://github.com/tegojs/tego-standard/pull/299)) (@dududuna)
- **web**: add promise with resolvers polyfill ([#291](https://github.com/tegojs/tego-standard/pull/291)) (@bai.zixv)
- table filter ([#288](https://github.com/tegojs/tego-standard/pull/288)) (@dududuna)

### 🔄 Changed

- **cloud-component**: optimize cloud component optimization plan ([#289](https://github.com/tegojs/tego-standard/pull/289)) (@bai.zixv)

## [1.6.0] - 2025-11-20

### ✨ Added

- adjust event source code for resource operation after event & perf(workflow): adjust workflow code for executed time ([#285](https://github.com/tegojs/tego-standard/pull/285)) (@bai.zixv)
- add backup progress and download progress & chore: cursor rules update & chore: update github workflow ([#280](https://github.com/tegojs/tego-standard/pull/280)) (@bai.zixv)
- approval summary support array type data & feat: change the column display of workflow and approval list pages ([#239](https://github.com/tegojs/tego-standard/pull/239)) (@bai.zixv)
- add cursor hooks for auto formatting and translation sync ([#282](https://github.com/tegojs/tego-standard/pull/282)) (@bai.zixv)

### 🐛 Fixed

- **workflow**: fix sync approval workflow ([#284](https://github.com/tegojs/tego-standard/pull/284)) (@bai.zixv)
- **backup**: fix timeout check for backup progress ([#283](https://github.com/tegojs/tego-standard/pull/283)) (@bai.zixv)
- **workflow-approval**: test logic & fix(workflow): useAction string reference & fix(workflow): duplicate workflow category default value & fix(data-source): collection table column width & chore(cursor): update lint check rules ([#279](https://github.com/tegojs/tego-standard/pull/279)) (@bai.zixv)
- approval cc details ([#269](https://github.com/tegojs/tego-standard/pull/269)) (@dududuna)
- export the current table function and add filtering criteria ([#271](https://github.com/tegojs/tego-standard/pull/271)) (@dududuna)
- approval add return and update approval navigation path ([#265](https://github.com/tegojs/tego-standard/pull/265)) (@dududuna)

## [1.5.1] - 2025-11-13

### 🐛 Fixed

- fixed approval reminder & approval records repeat ([#256](https://github.com/tegojs/tego-standard/pull/256)) (@bai.zixv)

### 🔄 Changed

- **core**: allow empty user status in token ([#267](https://github.com/tegojs/tego-standard/pull/267)) (@bai.zixv)


## [1.5.0] - 2025-11-11

### ✨ Added

- show app version hash and link, change logic (@bai.zixv)


## [1.4.0] - 2025-11-10

### ✨ Added

- add event source description field ([#241](https://github.com/tegojs/tego-standard/pull/241)) (@dududuna)
- backup common data ([#240](https://github.com/tegojs/tego-standard/pull/240)) (@bai.zixv)
- **scripts&client&module-web**: show version hash and link ([#235](https://github.com/tegojs/tego-standard/pull/235)) (@TomyJan)
- approval details display Approval number ([#223](https://github.com/tegojs/tego-standard/pull/223)) (@dududuna)
- **core&module-auth&module-user**: user status ([#213](https://github.com/tegojs/tego-standard/pull/213)) (@TomyJan)
- add event source category and workflow description ([#218](https://github.com/tegojs/tego-standard/pull/218)) (@dududuna)
- **plugin-field-bank-card-number**: bank card number field plugin ([#219](https://github.com/tegojs/tego-standard/pull/219)) (@TomyJan)
- approval sort ([#215](https://github.com/tegojs/tego-standard/pull/215)) (@dududuna)
- tablePagination ([#137](https://github.com/tegojs/tego-standard/pull/137)) (@dududuna)
- add packageName to plugin manager ([#135](https://github.com/tegojs/tego-standard/pull/135)) (@bai.zixv)
- tabs add draggable ([#111](https://github.com/tegojs/tego-standard/pull/111)) (@Winc159)
- non local storage ([#51](https://github.com/tegojs/tego-standard/pull/51)) (@张琳 Lin Zhang)
- add form edit plugin ([#35](https://github.com/tegojs/tego-standard/pull/35)) (@bai.zixv)
- drag handle page tab ([#24](https://github.com/tegojs/tego-standard/pull/24)) (@bai.zixv)

### 🐛 Fixed

- table column alignment does not apply to numbers ([#247](https://github.com/tegojs/tego-standard/pull/247)) (@dududuna)
- rsbuild config ([#246](https://github.com/tegojs/tego-standard/pull/246)) (@bai.zixv)
- workflow canvas overflow-x hidden & feat: add click to component editor & feat: add execute ended message & test empty execution ([#236](https://github.com/tegojs/tego-standard/pull/236)) (@bai.zixv)
- update approval process classification, workflow, and event source table fields ([#232](https://github.com/tegojs/tego-standard/pull/232)) (@dududuna)
- approval copy operation ([#222](https://github.com/tegojs/tego-standard/pull/222)) (@bai.zixv)
- workflow approval, old version support withdraw ([#211](https://github.com/tegojs/tego-standard/pull/211)) (@bai.zixv)
- sub-form ([#210](https://github.com/tegojs/tego-standard/pull/210)) (@dududuna)
- table pagination ([#209](https://github.com/tegojs/tego-standard/pull/209)) (@dududuna)
- table pagination ([#203](https://github.com/tegojs/tego-standard/pull/203)) (@dududuna)
- loop progress ([#200](https://github.com/tegojs/tego-standard/pull/200)) (@dududuna)
- mobileShare ([#153](https://github.com/tegojs/tego-standard/pull/153)) (@dududuna)
- fix missing async when create form ([#129](https://github.com/tegojs/tego-standard/pull/129)) (@Winc159)
- title name ([#145](https://github.com/tegojs/tego-standard/pull/145)) (@dududuna)
- fix calc result ([#144](https://github.com/tegojs/tego-standard/pull/144)) (@bai.zixv)
- fix formula view ([#143](https://github.com/tegojs/tego-standard/pull/143)) (@bai.zixv)
- cloudComponent ([#141](https://github.com/tegojs/tego-standard/pull/141)) (@dududuna)
- sharePage ([#139](https://github.com/tegojs/tego-standard/pull/139)) (@dududuna)
- table association filtering ([#102](https://github.com/tegojs/tego-standard/pull/102)) (@dududuna)
- form design 0813 ([#86](https://github.com/tegojs/tego-standard/pull/86)) (@Winc159)
- fixed user manual plugin namespace and acl ([#63](https://github.com/tegojs/tego-standard/pull/63)) (@bai.zixv)
- declare module should be @tego/server ([#50](https://github.com/tegojs/tego-standard/pull/50)) (@张琳 Lin Zhang)
- pdfjs worker src change to pdf.worker.min.mjs ([#48](https://github.com/tegojs/tego-standard/pull/48)) (@张琳 Lin Zhang)
- verify code (@Toby)
- multi app partners signin (@Toby)
- evaluator mathjs can not enabled (@sealday)
- upgrade to latest tego (@sealday)
- tbu and tbi (@sealday)
- mathjs plugin (@sealday)
- client version mismatch (@sealday)
- version mismatch (@sealday)

### 🔄 Changed

- import lodash and dayjs directly instead of via @tego/client and @tego/server ([#49](https://github.com/tegojs/tego-standard/pull/49)) (@张琳 Lin Zhang)
- using @tego/server and @tego/client ([#15](https://github.com/tegojs/tego-standard/pull/15)) (@张琳 Lin Zhang)
- remove core libs (@sealday)
- backup category ([#231](https://github.com/tegojs/tego-standard/pull/231)) (@TomyJan)
- support `bankCard` field types in formula interface ([#224](https://github.com/tegojs/tego-standard/pull/224)) (@TomyJan)
- **table-v2**: 行/列双向分批激活，降低首帧与首次更新开销 ([#180](https://github.com/tegojs/tego-standard/pull/180)) (@bai.zixv)


## [1.3.27] - 2025-07-28

### 🔄 Changed

- **core**: remove legacy preset package logic, plugins now defined via env ([#735](https://github.com/tegojs/tego-standard/pull/735)) (@张琳 Lin Zhang)
- mv apps to packages ([#734](https://github.com/tegojs/tego-standard/pull/734)) (@张琳 Lin Zhang)

### 📝 Documentation

- update readme (@sealday)


## [1.3.26] - 2025-07-27

### ✨ Added

- support dev install pass argv (@sealday)

### 🐛 Fixed

- dev mode install and upgrade ([#731](https://github.com/tegojs/tego-standard/pull/731)) (@张琳 Lin Zhang)
- dev command (@sealday)
- evaluators client export evaluate ([#730](https://github.com/tegojs/tego-standard/pull/730)) (@张琳 Lin Zhang)
- tego path (@sealday)

### 🔄 Changed

- remove plugins (@sealday)


## [1.3.25] - 2025-09-02

### ✨ Added

- tabs add draggable ([#111](https://github.com/tegojs/tego-standard/pull/111)) (@Winc159)

### 🐛 Fixed

- table association filtering ([#102](https://github.com/tegojs/tego-standard/pull/102)) (@dududuna)
- form design 0813 ([#86](https://github.com/tegojs/tego-standard/pull/86)) (@Winc159)
- fixed user manual plugin namespace and acl ([#63](https://github.com/tegojs/tego-standard/pull/63)) (@bai.zixv)


## [1.3.24] - 2025-08-04

### ✨ Added

- non local storage ([#51](https://github.com/tegojs/tego-standard/pull/51)) (@张琳 Lin Zhang)

### 🐛 Fixed

- declare module should be @tego/server ([#50](https://github.com/tegojs/tego-standard/pull/50)) (@张琳 Lin Zhang)


## [1.3.23] - 2025-08-03

### ✨ Added

- add form edit plugin ([#35](https://github.com/tegojs/tego-standard/pull/35)) (@bai.zixv)
- drag handle page tab ([#24](https://github.com/tegojs/tego-standard/pull/24)) (@bai.zixv)

### 🐛 Fixed

- pdfjs worker src change to pdf.worker.min.mjs ([#48](https://github.com/tegojs/tego-standard/pull/48)) (@张琳 Lin Zhang)

### 🔄 Changed

- import lodash and dayjs directly instead of via @tego/client and @tego/server ([#49](https://github.com/tegojs/tego-standard/pull/49)) (@张琳 Lin Zhang)


## [1.3.22] - 2025-07-29

### ✨ Added

- add feishu user manual plugin ([#728](https://github.com/tegojs/tego-standard/pull/728)) (@bai.zixv)

### 🐛 Fixed

- verify code (@Toby)
- multi app partners signin (@Toby)
- evaluator mathjs can not enabled (@sealday)
- upgrade to latest tego (@sealday)
- tbu and tbi (@sealday)
- mathjs plugin (@sealday)
- client version mismatch (@sealday)
- version mismatch (@sealday)
- theme editor demo pollution ([#729](https://github.com/tegojs/tego-standard/pull/729)) (@Winc159)

### 🔄 Changed

- using @tego/server and @tego/client ([#15](https://github.com/tegojs/tego-standard/pull/15)) (@张琳 Lin Zhang)
- remove core libs (@sealday)


## [1.3.21] - 2025-07-25

### 🐛 Fixed

- fix approval process tag color & remove unused code ([#695](https://github.com/tegojs/tego-standard/pull/695)) (@bai.zixv)
- errors in querying associated fields in tables ([#696](https://github.com/tegojs/tego-standard/pull/696)) (@dududuna)
- migration sharing function ([#655](https://github.com/tegojs/tego-standard/pull/655)) (@dududuna)
- improve custom titles ([#602](https://github.com/tegojs/tego-standard/pull/602)) (@dududuna)


## [1.3.20] - 2025-07-24

### ✨ Added

- date exact (@wildworker)
- smschangepwd ([#702](https://github.com/tegojs/tego-standard/pull/702)) (@wildworker)
- antd mobile select ([#699](https://github.com/tegojs/tego-standard/pull/699)) (@bai.zixv)
- main app signin  ([#681](https://github.com/tegojs/tego-standard/pull/681)) (@wildworker)

### 🐛 Fixed

- nightly entry ([#714](https://github.com/tegojs/tego-standard/pull/714)) (@wildworker)
- nightly image ([#708](https://github.com/tegojs/tego-standard/pull/708)) (@wildworker)
- duplicate add logger stream ([#700](https://github.com/tegojs/tego-standard/pull/700)) (@wildworker)


## [1.3.19] - 2025-07-17

### ✨ Added

- main app signin ([#639](https://github.com/tegojs/tego-standard/pull/639)) (@wildworker)

### 🐛 Fixed

- **devkit**: ensure build failure exits with code 1 (@sealday)


## [1.3.18] - 2025-07-17

### ✨ Added

- dynamic page ([#506](https://github.com/tegojs/tego-standard/pull/506)) (@bai.zixv)
- optimize mobile select ([#638](https://github.com/tegojs/tego-standard/pull/638)) (@bai.zixv)

### 🐛 Fixed

- **core**: ensure single i18next instance shared across core and plugins (@sealday)
- **core**: ensure single i18next instance shared across core and plugins (@sealday)
- **deps**: i18next version and revert @react-pdf/render version ([#669](https://github.com/tegojs/tego-standard/pull/669)) (@张琳 Lin Zhang)
- auto start undefined ([#663](https://github.com/tegojs/tego-standard/pull/663)) (@wildworker)
- reset pwd null ([#613](https://github.com/tegojs/tego-standard/pull/613)) (@wildworker)
- i18n editor ([#631](https://github.com/tegojs/tego-standard/pull/631)) (@bai.zixv)

### 🔄 Changed

- sub app upgrade after sub app self start ([#608](https://github.com/tegojs/tego-standard/pull/608)) (@wildworker)


## [1.3.17] - 2025-07-04

### 🐛 Fixed

- fix auth-sms namespace ([#604](https://github.com/tegojs/tego-standard/pull/604)) (@bai.zixv)
- nightly image ([#601](https://github.com/tegojs/tego-standard/pull/601)) (@wildworker)


## [1.3.16] - 2025-07-02

### 🐛 Fixed

- **core**: load presets plugin failed (@sealday)


## [1.3.15] - 2025-07-01

### 🐛 Fixed

- base image ([#598](https://github.com/tegojs/tego-standard/pull/598)) (@wildworker)


## [1.3.14] - 2025-07-01

### 🐛 Fixed

- tego-node-pg ([#596](https://github.com/tegojs/tego-standard/pull/596)) (@wildworker)
- dockerfile tego ([#594](https://github.com/tegojs/tego-standard/pull/594)) (@wildworker)
- docker compose samples change tachybase to tego (@sealday)


## [1.3.13] - 2025-06-30

### 🐛 Fixed

- tego command error ([#584](https://github.com/tegojs/tego-standard/pull/584)) (@张琳 Lin Zhang)

### 📝 Documentation

- rename tachybase to tego ([#583](https://github.com/tegojs/tego-standard/pull/583)) (@张琳 Lin Zhang)


## [1.3.12] - 2025-06-30

### 🐛 Fixed

- fixed mobile select component ([#576](https://github.com/tegojs/tego-standard/pull/576)) (@bai.zixv)
- mobile datepicker placeholder ([#571](https://github.com/tegojs/tego-standard/pull/571)) (@bai.zixv)
- fixed table pagination ([#581](https://github.com/tegojs/tego-standard/pull/581)) (@bai.zixv)
- tree structure filter with table prefix ([#574](https://github.com/tegojs/tego-standard/pull/574)) (@Winc159)

### 🔄 Changed

- devkit ([#561](https://github.com/tegojs/tego-standard/pull/561)) (@张琳 Lin Zhang)


## [1.3.11] - 2025-06-27

### 🐛 Fixed

- database mysql col ([#572](https://github.com/tegojs/tego-standard/pull/572)) (@wildworker)
- remove backup of plugin-list.md ([#564](https://github.com/tegojs/tego-standard/pull/564)) (@bai.zixv)


## [1.3.10] - 2025-06-26

### ✨ Added

- change welcome card router ([#560](https://github.com/tegojs/tego-standard/pull/560)) (@bai.zixv)

### 🐛 Fixed

- **full-text-search**: sequelize col ([#562](https://github.com/tegojs/tego-standard/pull/562)) (@wildworker)
- worker thread worker script path ([#563](https://github.com/tegojs/tego-standard/pull/563)) (@wildworker)


## [1.3.8] - 2025-06-25

### 🐛 Fixed

- docker path error (@sealday)


## [1.3.7] - 2025-06-24

### 🔄 Changed

- change to ts ([#551](https://github.com/tegojs/tego-standard/pull/551)) (@张琳 Lin Zhang)


## [1.3.6] - 2025-06-24

### 🐛 Fixed

- worker thread is not using the latest loader implementation ([#550](https://github.com/tegojs/tego-standard/pull/550)) (@张琳 Lin Zhang)


## [1.3.5] - 2025-06-24

### 🐛 Fixed

- build (@sealday)


## [1.3.4] - 2025-06-24

### 🐛 Fixed

- require cjs from esm is not permitted (@sealday)


## [1.3.2] - 2025-06-24

### 🐛 Fixed

- individual repo dev raise errors ([#548](https://github.com/tegojs/tego-standard/pull/548)) (@张琳 Lin Zhang)


## [1.3.1] - 2025-06-24

### 🐛 Fixed

- docker build engine ([#547](https://github.com/tegojs/tego-standard/pull/547)) (@张琳 Lin Zhang)


## [1.3.0] - 2025-06-24

### ✨ Added

- tachybase globals and add multiple path support ([#519](https://github.com/tegojs/tego-standard/pull/519)) (@张琳 Lin Zhang)

### 🐛 Fixed

- pnpm dev in empty packages ([#546](https://github.com/tegojs/tego-standard/pull/546)) (@张琳 Lin Zhang)
- preset engine errors ([#544](https://github.com/tegojs/tego-standard/pull/544)) (@张琳 Lin Zhang)
- import collection errors ([#541](https://github.com/tegojs/tego-standard/pull/541)) (@张琳 Lin Zhang)
- multi app share collection plugin can not load ([#540](https://github.com/tegojs/tego-standard/pull/540)) (@张琳 Lin Zhang)
- **client**: missing xlsx dep ([#533](https://github.com/tegojs/tego-standard/pull/533)) (@张琳 Lin Zhang)
- **server**: load plugin paths errors (@sealday)

### 🔄 Changed

- move default presets from server to engine ([#543](https://github.com/tegojs/tego-standard/pull/543)) (@张琳 Lin Zhang)
- move plugins to storage plugins ([#542](https://github.com/tegojs/tego-standard/pull/542)) (@张琳 Lin Zhang)


## [1.2.15] - 2025-06-23

### ✨ Added

- add debug logs to sync-plugin-list-to-docs-repo.yml ([#520](https://github.com/tegojs/tego-standard/pull/520)) (@bai.zixv)

### 🐛 Fixed

- init plugin copy text ([#523](https://github.com/tegojs/tego-standard/pull/523)) (@wildworker)
- update sync-plugin-list-to-docs-repo.yml ([#526](https://github.com/tegojs/tego-standard/pull/526)) (@bai.zixv)
- update sync-plugin-list-to-docs-repo.yml ([#525](https://github.com/tegojs/tego-standard/pull/525)) (@bai.zixv)
- update sync-plugin-list-to-docs-repo.yml ([#524](https://github.com/tegojs/tego-standard/pull/524)) (@bai.zixv)
- update sync-plugin-list-to-docs-repo.yml ([#522](https://github.com/tegojs/tego-standard/pull/522)) (@bai.zixv)
- update sync-plugin-list-to-docs-repo.yml ([#521](https://github.com/tegojs/tego-standard/pull/521)) (@bai.zixv)


## [1.2.14] - 2025-06-23

### ✨ Added

- run engine by default and add some tests ([#518](https://github.com/tegojs/tego-standard/pull/518)) (@张琳 Lin Zhang)


## [1.2.13] - 2025-06-21

### 🐛 Fixed

- copy text not found ([#517](https://github.com/tegojs/tego-standard/pull/517)) (@张琳 Lin Zhang)


## [1.2.12] - 2025-06-21

### 🐛 Fixed

- backup plugin check all & add text-copy plugin ([#515](https://github.com/tegojs/tego-standard/pull/515)) (@bai.zixv)
- **auth**: updateOrCreate filterKeys error ([#514](https://github.com/tegojs/tego-standard/pull/514)) (@wildworker)

### 🔄 Changed

- optimize engine parameters, restructure engine loading logic and update readme ([#508](https://github.com/tegojs/tego-standard/pull/508)) (@张琳 Lin Zhang)


## [1.2.11] - 2025-06-19

### ✨ Added

- add password policy, expiration date & fix: fix document title ([#504](https://github.com/tegojs/tego-standard/pull/504)) (@bai.zixv)

### 🐛 Fixed

- (auth)token expire suddenly ([#507](https://github.com/tegojs/tego-standard/pull/507)) (@wildworker)
- migration when table is not exist ([#505](https://github.com/tegojs/tego-standard/pull/505)) (@wildworker)


## [1.2.10] - 2025-06-19

### 🐛 Fixed

- tachybase team (@sealday)


## [1.2.8] - 2025-06-19

### 🐛 Fixed

- start with no SERVE PATH is ok ([#501](https://github.com/tegojs/tego-standard/pull/501)) (@张琳 Lin Zhang)


## [1.2.7] - 2025-06-19

### ✨ Added

- engine can prepare plugins now ([#500](https://github.com/tegojs/tego-standard/pull/500)) (@张琳 Lin Zhang)
- instrumentation optimizations ([#499](https://github.com/tegojs/tego-standard/pull/499)) (@张琳 Lin Zhang)
- instrumentation optimizations ([#424](https://github.com/tegojs/tego-standard/pull/424)) (@Winc159)

### 🐛 Fixed

- pnpm-lock.yaml (@sealday)
- approval create ([#497](https://github.com/tegojs/tego-standard/pull/497)) (@bai.zixv)
- multi app stop button ([#496](https://github.com/tegojs/tego-standard/pull/496)) (@wildworker)
- approvalCopy status ([#445](https://github.com/tegojs/tego-standard/pull/445)) (@dududuna)

### 🔄 Changed

- workflow-approval ([#462](https://github.com/tegojs/tego-standard/pull/462)) (@bai.zixv)


## [1.2.6] - 2025-06-18

### 🐛 Fixed

- set PluginPresets when preset is null ([#491](https://github.com/tegojs/tego-standard/pull/491)) (@wildworker)
- win path join error (@sealday)


## [1.2.5] - 2025-06-18

### 🐛 Fixed

- **core**: multer version mismatch ([#490](https://github.com/tegojs/tego-standard/pull/490)) (@张琳 Lin Zhang)


## [1.2.3] - 2025-06-17

### 🐛 Fixed

- docker-engine path ([#489](https://github.com/tegojs/tego-standard/pull/489)) (@张琳 Lin Zhang)


## [1.2.0] - 2025-06-17

### 🐛 Fixed

- workdir (@sealday)


## [1.1.33] - 2025-06-17

### 🐛 Fixed

- load commands error (@sealday)


## [1.1.30] - 2025-06-17

### ✨ Added

- support text copy ([#479](https://github.com/tegojs/tego-standard/pull/479)) (@bai.zixv)
- backup module support check all items ([#482](https://github.com/tegojs/tego-standard/pull/482)) (@bai.zixv)
- support more engine arch ([#487](https://github.com/tegojs/tego-standard/pull/487)) (@张琳 Lin Zhang)

### 🐛 Fixed

- multi app preset ([#484](https://github.com/tegojs/tego-standard/pull/484)) (@wildworker)


## [1.1.29] - 2025-06-17

### 🐛 Fixed

- tag name ([#485](https://github.com/tegojs/tego-standard/pull/485)) (@张琳 Lin Zhang)


## [1.1.24] - 2025-06-17

### 🐛 Fixed

- engine guess wrong path ([#481](https://github.com/tegojs/tego-standard/pull/481)) (@张琳 Lin Zhang)


## [1.1.23] - 2025-06-17

### 🐛 Fixed

- engine load ([#480](https://github.com/tegojs/tego-standard/pull/480)) (@张琳 Lin Zhang)
- event source real time refresh ([#478](https://github.com/tegojs/tego-standard/pull/478)) (@wildworker)


## [1.1.22] - 2025-06-17

### ✨ Added

- init with project name ([#477](https://github.com/tegojs/tego-standard/pull/477)) (@张琳 Lin Zhang)


## [1.1.21] - 2025-06-17

### 🐛 Fixed

- build type error ([#463](https://github.com/tegojs/tego-standard/pull/463)) (@bai.zixv)


## [1.1.20] - 2025-06-17

### ✨ Added

- add engine start in workspace script ([#468](https://github.com/tegojs/tego-standard/pull/468)) (@张琳 Lin Zhang)


## [1.1.17] - 2025-06-17

### 🐛 Fixed

- worker work in engine mode and fix oxlint rules ([#466](https://github.com/tegojs/tego-standard/pull/466)) (@张琳 Lin Zhang)


## [1.1.16] - 2025-06-16

### ✨ Added

- tachybase engine docker ([#464](https://github.com/tegojs/tego-standard/pull/464)) (@张琳 Lin Zhang)

### 🐛 Fixed

- tachybase-engine docker name (@sealday)


## [1.1.15] - 2025-06-16

### 🐛 Fixed

- lru and load migrations in npx (@sealday)


## [1.1.14] - 2025-06-16

### 🐛 Fixed

- pnpm-lock.yaml (@sealday)


## [1.1.13] - 2025-06-16

### 🐛 Fixed

- glob version fixed (@sealday)


## [1.1.12] - 2025-06-16

### 🐛 Fixed

- engine should dep react-dom (@sealday)


## [1.1.11] - 2025-06-16

### 🐛 Fixed

- server deps (@sealday)


## [1.1.10] - 2025-06-16

### 🐛 Fixed

- engine bin ([#456](https://github.com/tegojs/tego-standard/pull/456)) (@张琳 Lin Zhang)


## [1.1.9] - 2025-06-16

### ✨ Added

- support init with custom plugins (@sealday)

### 🐛 Fixed

- cli load env.e2e.example by default (@sealday)
- engine type errors (@sealday)
- engine client path (@sealday)


## [1.1.8] - 2025-06-16

### 🐛 Fixed

- pnpm workspace (@sealday)


## [1.1.7] - 2025-06-16

### 🔄 Changed

- remove preset packages & rename app-rs ([#455](https://github.com/tegojs/tego-standard/pull/455)) (@张琳 Lin Zhang)


## [1.1.6] - 2025-06-13

### 🐛 Fixed

- groupblock data is incorrect after deselecting the table ([#454](https://github.com/tegojs/tego-standard/pull/454)) (@dududuna)
- sync message error ([#452](https://github.com/tegojs/tego-standard/pull/452)) (@wildworker)
- groupTable Filter ([#450](https://github.com/tegojs/tego-standard/pull/450)) (@dududuna)
- groupblock data is incorrect after deselecting the table ([#396](https://github.com/tegojs/tego-standard/pull/396)) (@dududuna)


## [1.1.5] - 2025-06-11

### ✨ Added

- support external request in custom request action ([#449](https://github.com/tegojs/tego-standard/pull/449)) (@bai.zixv)

### 🐛 Fixed

- engine window filepath ([#443](https://github.com/tegojs/tego-standard/pull/443)) (@wildworker)


## [1.1.4] - 2025-06-09

### 🐛 Fixed

- hide extra when form item description empty ([#444](https://github.com/tegojs/tego-standard/pull/444)) (@Winc159)
- sdk axios version ([#442](https://github.com/tegojs/tego-standard/pull/442)) (@wildworker)
- axios work for client/server and engine mode (@sealday)

### 🔄 Changed

- pkg load in memory ([#448](https://github.com/tegojs/tego-standard/pull/448)) (@张琳 Lin Zhang)


## [1.1.3] - 2025-05-26

### 🐛 Fixed

- axios error ([#441](https://github.com/tegojs/tego-standard/pull/441)) (@wildworker)


## [1.1.2] - 2025-05-23

### 🐛 Fixed

- **backup**: delete autobackup password ([#439](https://github.com/tegojs/tego-standard/pull/439)) (@wildworker)
- mathjs version (@sealday)


## [1.1.1] - 2025-05-23

### 🐛 Fixed

- app-rs dist (@sealday)


## [1.1.0] - 2025-05-23

### 🐛 Fixed

- adapter red node plugin ([#438](https://github.com/tegojs/tego-standard/pull/438)) (@张琳 Lin Zhang)
- ocr convert build ([#437](https://github.com/tegojs/tego-standard/pull/437)) (@张琳 Lin Zhang)

### 📝 Documentation

- update readme (@sealday)


## [1.0.25] - 2025-05-21

### 🐛 Fixed

- slider ([#436](https://github.com/tegojs/tego-standard/pull/436)) (@dududuna)


## [1.0.23] - 2025-05-20

### ✨ Added

- create script and edit package ([#428](https://github.com/tegojs/tego-standard/pull/428)) (@Winc159)
- preliminary support for engine mode ([#430](https://github.com/tegojs/tego-standard/pull/430)) (@张琳 Lin Zhang)
- add number slider ([#425](https://github.com/tegojs/tego-standard/pull/425)) (@dududuna)
- add share ([#431](https://github.com/tegojs/tego-standard/pull/431)) (@dududuna)
- auto backup ([#420](https://github.com/tegojs/tego-standard/pull/420)) (@wildworker)
- change workflow test to codemirror component ([#427](https://github.com/tegojs/tego-standard/pull/427)) (@Winc159)

### 🐛 Fixed

- slider ([#433](https://github.com/tegojs/tego-standard/pull/433)) (@dududuna)
- depart server client acl not match ([#432](https://github.com/tegojs/tego-standard/pull/432)) (@wildworker)

### 🔄 Changed

- workflows categories ([#423](https://github.com/tegojs/tego-standard/pull/423)) (@Winc159)


## [1.0.22] - 2025-04-25

### ✨ Added

- refactor instrumentation ([#415](https://github.com/tegojs/tego-standard/pull/415)) (@Winc159)


## [1.0.20] - 2025-04-25

### ✨ Added

- add prefix and suffix to number field ([#421](https://github.com/tegojs/tego-standard/pull/421)) (@Winc159)
- add recharts ([#412](https://github.com/tegojs/tego-standard/pull/412)) (@dududuna)

### 🐛 Fixed

- pnpm install error ([#422](https://github.com/tegojs/tego-standard/pull/422)) (@wildworker)


## [1.0.19] - 2025-04-23

### ✨ Added

- step form ([#419](https://github.com/tegojs/tego-standard/pull/419)) (@bai.zixv)
- multiapp action ([#414](https://github.com/tegojs/tego-standard/pull/414)) (@dududuna)

### 🐛 Fixed

- approval icon color ([#416](https://github.com/tegojs/tego-standard/pull/416)) (@dududuna)
- corepack sign error ([#417](https://github.com/tegojs/tego-standard/pull/417)) (@wildworker)


## [1.0.18] - 2025-04-18

### 🐛 Fixed

- workflow approval, FuzzySearch id is isInteger ([#411](https://github.com/tegojs/tego-standard/pull/411)) (@bai.zixv)


## [1.0.17] - 2025-04-18

### ✨ Added

- multi application display and addition operation ([#408](https://github.com/tegojs/tego-standard/pull/408)) (@dududuna)


## [1.0.16] - 2025-04-17

### 🐛 Fixed

- pnpm build error ([#410](https://github.com/tegojs/tego-standard/pull/410)) (@wildworker)


## [1.0.15] - 2025-04-15

### ✨ Added

- sms auth agree ([#406](https://github.com/tegojs/tego-standard/pull/406)) (@wildworker)

### 🐛 Fixed

- http field int allow float type ([#407](https://github.com/tegojs/tego-standard/pull/407)) (@wildworker)


## [1.0.14] - 2025-04-14

### 🐛 Fixed

- dbviews acl ([#405](https://github.com/tegojs/tego-standard/pull/405)) (@wildworker)
- sub-app online user error ([#404](https://github.com/tegojs/tego-standard/pull/404)) (@wildworker)


## [1.0.13] - 2025-04-11

### 🐛 Fixed

- typo-error ([#401](https://github.com/tegojs/tego-standard/pull/401)) (@wildworker)
- subapp same appkey ([#400](https://github.com/tegojs/tego-standard/pull/400)) (@wildworker)

### 🔄 Changed

- online-user event center ([#402](https://github.com/tegojs/tego-standard/pull/402)) (@wildworker)
- plugin manual notification enhance ([#399](https://github.com/tegojs/tego-standard/pull/399)) (@wildworker)


## [1.0.12] - 2025-04-09

### ✨ Added

- online user and clinet count ([#398](https://github.com/tegojs/tego-standard/pull/398)) (@wildworker)
- plugin-ocr-convert ([#393](https://github.com/tegojs/tego-standard/pull/393)) (@wildworker)

### 🐛 Fixed

- translate, fix zh language support ([#394](https://github.com/tegojs/tego-standard/pull/394)) (@bai.zixv)
- migration error, create sql function error, api-keys middleware error ([#392](https://github.com/tegojs/tego-standard/pull/392)) (@wildworker)

### 🔄 Changed

- multi app show ([#397](https://github.com/tegojs/tego-standard/pull/397)) (@wildworker)


## [1.0.11] - 2025-04-03

### 🐛 Fixed

- api-keys migration error ([#391](https://github.com/tegojs/tego-standard/pull/391)) (@wildworker)


## [1.0.10] - 2025-04-03

### 🐛 Fixed

- can change primary key or unique in http collection ([#387](https://github.com/tegojs/tego-standard/pull/387)) (@wildworker)
- token longer than 255 ([#389](https://github.com/tegojs/tego-standard/pull/389)) (@wildworker)
- sub app loop ([#386](https://github.com/tegojs/tego-standard/pull/386)) (@wildworker)
- reserver workflow trigger ([#384](https://github.com/tegojs/tego-standard/pull/384)) (@wildworker)

### 🔄 Changed

- backup download logic, error show ([#390](https://github.com/tegojs/tego-standard/pull/390)) (@wildworker)


## [1.0.9] - 2025-04-03

### 🔄 Changed

- better log, better sub app tables ([#383](https://github.com/tegojs/tego-standard/pull/383)) (@wildworker)


## [1.0.8] - 2025-04-03

### 🔄 Changed

- show user when nickname is null ([#382](https://github.com/tegojs/tego-standard/pull/382)) (@wildworker)


## [1.0.7] - 2025-04-02

### ✨ Added

- system update message nofication ([#375](https://github.com/tegojs/tego-standard/pull/375)) (@Winc159)
- iframe, CodeMirror ([#380](https://github.com/tegojs/tego-standard/pull/380)) (@bai.zixv)

### 🐛 Fixed

- backup subapp worker appName error ([#379](https://github.com/tegojs/tego-standard/pull/379)) (@wildworker)

### 🔄 Changed

- sub app ([#381](https://github.com/tegojs/tego-standard/pull/381)) (@wildworker)


## [1.0.6] - 2025-04-01

### 🐛 Fixed

- define primary ([#378](https://github.com/tegojs/tego-standard/pull/378)) (@wildworker)


## [1.0.5] - 2025-04-01

### 🐛 Fixed

- isOpen ([#377](https://github.com/tegojs/tego-standard/pull/377)) (@wildworker)


## [1.0.4] - 2025-04-01

### ✨ Added

- sub app cname validator ([#373](https://github.com/tegojs/tego-standard/pull/373)) (@wildworker)

### 🐛 Fixed

- change app already running ([#366](https://github.com/tegojs/tego-standard/pull/366)) (@Winc159)
- $dateBetween error ([#368](https://github.com/tegojs/tego-standard/pull/368)) (@wildworker)
- backup individual file path ([#372](https://github.com/tegojs/tego-standard/pull/372)) (@wildworker)


## [1.0.3] - 2025-03-31

### ✨ Added

- remove multiple app translation ([#371](https://github.com/tegojs/tego-standard/pull/371)) (@bai.zixv)


## [1.0.2] - 2025-03-31

### 🐛 Fixed

- multi-app acl erorr ([#370](https://github.com/tegojs/tego-standard/pull/370)) (@wildworker)


## [1.0.1] - 2025-03-31

### ✨ Added

- auth, translate ([#369](https://github.com/tegojs/tego-standard/pull/369)) (@bai.zixv)
- limit worker count ([#346](https://github.com/tegojs/tego-standard/pull/346)) (@wildworker)
- login, translate ([#348](https://github.com/tegojs/tego-standard/pull/348)) (@bai.zixv)
- table alignment method added ([#351](https://github.com/tegojs/tego-standard/pull/351)) (@dududuna)
- page, tab, drag ([#354](https://github.com/tegojs/tego-standard/pull/354)) (@bai.zixv)
- scroll area, change default value to hidden ([#357](https://github.com/tegojs/tego-standard/pull/357)) (@bai.zixv)

### 🐛 Fixed

- subtab secondlevelselect linkage ([#364](https://github.com/tegojs/tego-standard/pull/364)) (@Winc159)


## [1.0.0] - 2025-03-27

### 🐛 Fixed

- update readme file ([#363](https://github.com/tegojs/tego-standard/pull/363)) (@wildworker)


## [0.23.66] - 2025-03-27

### ✨ Added

- add multi-app block, change style ([#335](https://github.com/tegojs/tego-standard/pull/335)) (@bai.zixv)
- token policy ([#331](https://github.com/tegojs/tego-standard/pull/331)) (@wildworker)
- **auth-login**: support new style login page ([#308](https://github.com/tegojs/tego-standard/pull/308)) (@bai.zixv)
- security password policy ([#323](https://github.com/tegojs/tego-standard/pull/323)) (@wildworker)
- workflow node, dump and upload ([#328](https://github.com/tegojs/tego-standard/pull/328)) (@Winc159)
- add existence check to the condition ([#312](https://github.com/tegojs/tego-standard/pull/312)) (@Winc159)
- add custom types to components ([#305](https://github.com/tegojs/tego-standard/pull/305)) (@dududuna)

### 🐛 Fixed

- action name ([#361](https://github.com/tegojs/tego-standard/pull/361)) (@wildworker)
- rolesUsers primary key error ([#359](https://github.com/tegojs/tego-standard/pull/359)) (@wildworker)
- unable to view internal messages ([#350](https://github.com/tegojs/tego-standard/pull/350)) (@dududuna)
- env secrets use error ([#356](https://github.com/tegojs/tego-standard/pull/356)) (@wildworker)
- error in creating summary card ([#353](https://github.com/tegojs/tego-standard/pull/353)) (@dududuna)
- dataSource collection fields acl error ([#355](https://github.com/tegojs/tego-standard/pull/355)) (@wildworker)
- datasource collections acl error ([#352](https://github.com/tegojs/tego-standard/pull/352)) (@wildworker)
- workflows list acl loggedIn ([#349](https://github.com/tegojs/tego-standard/pull/349)) (@wildworker)
- data is incorrect after canceling the filtering table ([#347](https://github.com/tegojs/tego-standard/pull/347)) (@dududuna)
- format code (@Toby)
- locale error (@Toby)
- clean code (@Toby)
- locale, user lock policy (@Toby)
- different locale, role between main app and sub appp ([#340](https://github.com/tegojs/tego-standard/pull/340)) (@wildworker)
- password strength in sign up ([#338](https://github.com/tegojs/tego-standard/pull/338)) (@wildworker)
- internal messages cannot use reference templates ([#337](https://github.com/tegojs/tego-standard/pull/337)) (@dududuna)
- ci on dev ([#329](https://github.com/tegojs/tego-standard/pull/329)) ([#336](https://github.com/tegojs/tego-standard/pull/336)) (@wildworker)
- http show baseURL, show HTTP ([#334](https://github.com/tegojs/tego-standard/pull/334)) (@wildworker)
- table, sort issue ([#333](https://github.com/tegojs/tego-standard/pull/333)) (@Winc159)
- default value has not been deleted ([#332](https://github.com/tegojs/tego-standard/pull/332)) (@dududuna)
- linkage rule update not refreshing issue ([#330](https://github.com/tegojs/tego-standard/pull/330)) (@Winc159)
- the form does not have a default value selection ([#324](https://github.com/tegojs/tego-standard/pull/324)) (@dududuna)
- the filtering criteria for groupBlock are incorrect ([#326](https://github.com/tegojs/tego-standard/pull/326)) (@dududuna)
- acl dataSource:list acl error ([#322](https://github.com/tegojs/tego-standard/pull/322)) (@wildworker)
- approval processing time for draft status ([#314](https://github.com/tegojs/tego-standard/pull/314)) (@dududuna)
- approval process time line ([#309](https://github.com/tegojs/tego-standard/pull/309)) (@bai.zixv)


## [0.23.65] - 2025-03-20

### 🐛 Fixed

- ci on dev ([#329](https://github.com/tegojs/tego-standard/pull/329)) (@wildworker)


## [0.23.64] - 2025-03-13

### 🐛 Fixed

- dataSource error ([#316](https://github.com/tegojs/tego-standard/pull/316)) (@wildworker)


## [0.23.63] - 2025-03-13

### 🐛 Fixed

- **collection**: collections error ([#315](https://github.com/tegojs/tego-standard/pull/315)) (@wildworker)


## [0.23.62] - 2025-03-13

### 🐛 Fixed

- association table acl error ([#313](https://github.com/tegojs/tego-standard/pull/313)) (@wildworker)


## [0.23.61] - 2025-03-13

### ✨ Added

- bind work before submit success ([#298](https://github.com/tegojs/tego-standard/pull/298)) (@wildworker)

### 🐛 Fixed

- display approval list during approval processing ([#304](https://github.com/tegojs/tego-standard/pull/304)) (@dududuna)
- limit action acl ([#294](https://github.com/tegojs/tego-standard/pull/294)) (@wildworker)
- groupBlock migration to chart plugin ([#302](https://github.com/tegojs/tego-standard/pull/302)) (@dududuna)


## [0.23.60] - 2025-03-07

### 🐛 Fixed

- approval, draft should trigger workflow, to create execution record ([#300](https://github.com/tegojs/tego-standard/pull/300)) (@bai.zixv)


## [0.23.59] - 2025-03-06

### 🐛 Fixed

- approval-mobile, workflow key ([#299](https://github.com/tegojs/tego-standard/pull/299)) (@bai.zixv)


## [0.23.58] - 2025-03-06

### ✨ Added

- workflow, add remarks field for all workflow node ([#293](https://github.com/tegojs/tego-standard/pull/293)) (@bai.zixv)

### 🐛 Fixed

- application table error, middleware error ([#296](https://github.com/tegojs/tego-standard/pull/296)) (@wildworker)
- env-secrets built-in, api-logs error in upgrade ([#297](https://github.com/tegojs/tego-standard/pull/297)) (@wildworker)
- duplication button setting bar style ([#292](https://github.com/tegojs/tego-standard/pull/292)) (@dududuna)


## [0.23.57] - 2025-03-05

### 🐛 Fixed

- there is no query data in the associated table ([#295](https://github.com/tegojs/tego-standard/pull/295)) (@dududuna)
- clicking on the radio button did not clear it ([#291](https://github.com/tegojs/tego-standard/pull/291)) (@dududuna)


## [0.23.56] - 2025-03-04

### ✨ Added

- page, tab,settings ([#282](https://github.com/tegojs/tego-standard/pull/282)) (@bai.zixv)

### 🐛 Fixed

- resetting will overwrite the data range ([#289](https://github.com/tegojs/tego-standard/pull/289)) (@dududuna)
- duplicate form filtering criteria ([#287](https://github.com/tegojs/tego-standard/pull/287)) (@dududuna)
- addBelongsToManyThrough  filter null ([#290](https://github.com/tegojs/tego-standard/pull/290)) (@wildworker)
- full-text-search type error ([#288](https://github.com/tegojs/tego-standard/pull/288)) (@wildworker)
- aggregation belongsToMany through ([#283](https://github.com/tegojs/tego-standard/pull/283)) (@wildworker)

### 🔄 Changed

- show backup download percent ([#285](https://github.com/tegojs/tego-standard/pull/285)) (@wildworker)


## [0.23.55] - 2025-02-28

### 🐛 Fixed

- approval, initAt ([#280](https://github.com/tegojs/tego-standard/pull/280)) (@bai.zixv)


## [0.23.54] - 2025-02-27

### 🐛 Fixed

- loop import ([#279](https://github.com/tegojs/tego-standard/pull/279)) (@wildworker)


## [0.23.53] - 2025-02-27

### 🐛 Fixed

- code error ([#278](https://github.com/tegojs/tego-standard/pull/278)) (@wildworker)


## [0.23.52] - 2025-02-27

### 🐛 Fixed

- postgre date,number error ([#277](https://github.com/tegojs/tego-standard/pull/277)) (@wildworker)
- custom request not show after add ([#276](https://github.com/tegojs/tego-standard/pull/276)) (@wildworker)


## [0.23.51] - 2025-02-27

### ✨ Added

- page, tab ([#273](https://github.com/tegojs/tego-standard/pull/273)) (@bai.zixv)

### 🐛 Fixed

- modal, internal scroll ([#275](https://github.com/tegojs/tego-standard/pull/275)) (@bai.zixv)
- custom request setting environmentVariables null ([#274](https://github.com/tegojs/tego-standard/pull/274)) (@wildworker)


## [0.23.50] - 2025-02-27

### ✨ Added

- event-source & workflows, modify the presentation of the table ([#265](https://github.com/tegojs/tego-standard/pull/265)) (@bai.zixv)
- plugin env secrets ([#248](https://github.com/tegojs/tego-standard/pull/248)) (@wildworker)
- translate ([#262](https://github.com/tegojs/tego-standard/pull/262)) (@bai.zixv)

### 🐛 Fixed

- lack return next() in middlewares ([#268](https://github.com/tegojs/tego-standard/pull/268)) (@wildworker)
- event-source error report ([#264](https://github.com/tegojs/tego-standard/pull/264)) (@wildworker)
- custom request ([#253](https://github.com/tegojs/tego-standard/pull/253)) (@wildworker)
- api-logs error ([#266](https://github.com/tegojs/tego-standard/pull/266)) (@wildworker)
- conflict issue between filtering and sorting ([#263](https://github.com/tegojs/tego-standard/pull/263)) (@dududuna)

### 🔄 Changed

- page component ([#270](https://github.com/tegojs/tego-standard/pull/270)) (@bai.zixv)
- role check error redirect to signIn ([#267](https://github.com/tegojs/tego-standard/pull/267)) (@wildworker)


## [0.23.49] - 2025-02-21

### 🐛 Fixed

- some bug api logs , tmpl password ([#261](https://github.com/tegojs/tego-standard/pull/261)) (@wildworker)


## [0.23.48] - 2025-02-21

### ✨ Added

- block-charts, compatibility errors & translate ([#258](https://github.com/tegojs/tego-standard/pull/258)) (@bai.zixv)

### 🐛 Fixed

- create tachybase error ([#257](https://github.com/tegojs/tego-standard/pull/257)) (@wildworker)
- event-source triggerOnAssociation error ([#260](https://github.com/tegojs/tego-standard/pull/260)) (@wildworker)
- erorr for add primary key in order ([#259](https://github.com/tegojs/tego-standard/pull/259)) (@wildworker)
- delete effectlibraries ([#249](https://github.com/tegojs/tego-standard/pull/249)) (@Winc159)


## [0.23.47] - 2025-02-20

### 🐛 Fixed

- context loss of internal message ([#255](https://github.com/tegojs/tego-standard/pull/255)) (@dududuna)
- mobile, DatePicker, validDate  &  approval, mobile, status  ([#256](https://github.com/tegojs/tego-standard/pull/256)) (@bai.zixv)


## [0.23.46] - 2025-02-20

### ✨ Added

- approval, mobile ([#251](https://github.com/tegojs/tego-standard/pull/251)) (@bai.zixv)
- new plugin api logs ([#246](https://github.com/tegojs/tego-standard/pull/246)) (@Winc159)

### 🐛 Fixed

- workflowKey not send in mobile ([#254](https://github.com/tegojs/tego-standard/pull/254)) (@wildworker)
- sort-field not  include in group ([#250](https://github.com/tegojs/tego-standard/pull/250)) (@wildworker)
- custom workflow trigger show throw error ([#245](https://github.com/tegojs/tego-standard/pull/245)) (@wildworker)
- http collection error ([#244](https://github.com/tegojs/tego-standard/pull/244)) (@wildworker)

### 🔄 Changed

- migrate formily codes to schema ([#247](https://github.com/tegojs/tego-standard/pull/247)) (@张琳 Lin Zhang)
- eventSources ([#214](https://github.com/tegojs/tego-standard/pull/214)) (@wildworker)


## [0.23.45] - 2025-02-13

### ✨ Added

- workflow approval add retry and execution time ([#236](https://github.com/tegojs/tego-standard/pull/236)) (@Winc159)

### 🐛 Fixed

- http collection acl ([#242](https://github.com/tegojs/tego-standard/pull/242)) (@wildworker)
- database event send transaction to workflow ([#243](https://github.com/tegojs/tego-standard/pull/243)) (@wildworker)


## [0.23.44] - 2025-02-13

### 🐛 Fixed

- **message**: fix message sms error ([#237](https://github.com/tegojs/tego-standard/pull/237)) (@bai.zixv)
- subapp get swagger not set headers hostname ([#241](https://github.com/tegojs/tego-standard/pull/241)) (@wildworker)
- sub domain sub app not get websocket message ([#240](https://github.com/tegojs/tego-standard/pull/240)) (@wildworker)
- the prompt message did not end or close correctly ([#239](https://github.com/tegojs/tego-standard/pull/239)) (@dududuna)


## [0.23.43] - 2025-02-11

### 🐛 Fixed

- corepack build error ([#235](https://github.com/tegojs/tego-standard/pull/235)) (@wildworker)


## [0.23.42] - 2025-02-11

### ✨ Added

- execution add retry function ([#228](https://github.com/tegojs/tego-standard/pull/228)) (@Winc159)
- add custom tags to reading mode ([#220](https://github.com/tegojs/tego-standard/pull/220)) (@dududuna)
- support move workflow ([#217](https://github.com/tegojs/tego-standard/pull/217)) (@wildworker)
- workflow analysis tool ([#222](https://github.com/tegojs/tego-standard/pull/222)) (@Winc159)

### 🐛 Fixed

- react-i18next lead to retry function error ([#234](https://github.com/tegojs/tego-standard/pull/234)) (@Winc159)
- the prompt message did not end or close correctly ([#231](https://github.com/tegojs/tego-standard/pull/231)) (@dududuna)
- filter block，save prev merged filter (@dududuna)
- replace non paginated query parameters ([#230](https://github.com/tegojs/tego-standard/pull/230)) (@dududuna)
- replace non paginated query parameters ([#229](https://github.com/tegojs/tego-standard/pull/229)) (@dududuna)
- rest api baseUrl not show ([#225](https://github.com/tegojs/tego-standard/pull/225)) (@wildworker)
- postgres search column not found ([#223](https://github.com/tegojs/tego-standard/pull/223)) (@wildworker)
- tb typo ([#221](https://github.com/tegojs/tego-standard/pull/221)) (@张琳 Lin Zhang)
- **client**: debug tool now can acquire latest schema ([#219](https://github.com/tegojs/tego-standard/pull/219)) (@张琳 Lin Zhang)
- **module-users**: can not modify roles ([#218](https://github.com/tegojs/tego-standard/pull/218)) (@张琳 Lin Zhang)

### 🔄 Changed

- custom event source & workflow-approval ([#224](https://github.com/tegojs/tego-standard/pull/224)) (@bai.zixv)


## [0.23.41] - 2025-01-22

### ✨ Added

- menu, style color ([#211](https://github.com/tegojs/tego-standard/pull/211)) (@bai.zixv)
- menu, submenu, style ([#209](https://github.com/tegojs/tego-standard/pull/209)) (@bai.zixv)

### 🐛 Fixed

- replace TabPaneInitialize with Popup: addTab ([#216](https://github.com/tegojs/tego-standard/pull/216)) (@dududuna)
- approval, fix form ([#208](https://github.com/tegojs/tego-standard/pull/208)) (@bai.zixv)
- add blocks to improve tags ([#210](https://github.com/tegojs/tego-standard/pull/210)) (@dududuna)
- cron off not work, event off ([#212](https://github.com/tegojs/tego-standard/pull/212)) (@wildworker)
- summary chart settings hide classification fields ([#205](https://github.com/tegojs/tego-standard/pull/205)) (@dududuna)
- dataSources.role not found ([#206](https://github.com/tegojs/tego-standard/pull/206)) (@wildworker)

### 🔄 Changed

- full-text search, support enum(single or multiple) ([#207](https://github.com/tegojs/tego-standard/pull/207)) (@wildworker)


## [0.23.40] - 2025-01-19

### ✨ Added

- chart table can sort by column now and fix group table redundant category field ([#204](https://github.com/tegojs/tego-standard/pull/204)) (@张琳 Lin Zhang)
- **charts**: groudedTable ([#201](https://github.com/tegojs/tego-standard/pull/201)) (@bai.zixv)
- menu, menu add button ([#197](https://github.com/tegojs/tego-standard/pull/197)) (@bai.zixv)
- support resource action trigger on assocation ([#202](https://github.com/tegojs/tego-standard/pull/202)) (@张琳 Lin Zhang)

### 🐛 Fixed

- group table config errors and fix styles ([#203](https://github.com/tegojs/tego-standard/pull/203)) (@张琳 Lin Zhang)


## [0.23.39] - 2025-01-17

### 🐛 Fixed

- workflow, update or create attachment ([#200](https://github.com/tegojs/tego-standard/pull/200)) (@bai.zixv)
- can not signup ([#195](https://github.com/tegojs/tego-standard/pull/195)) (@wildworker)

### 🔄 Changed

- right-bottom quick tool should be a system machanism ([#199](https://github.com/tegojs/tego-standard/pull/199)) (@张琳 Lin Zhang)


## [0.23.38] - 2025-01-16

### ✨ Added

- menu, search style, & sidebar add menu style & fuzzy search remove change search ([#194](https://github.com/tegojs/tego-standard/pull/194)) (@bai.zixv)


## [0.23.37] - 2025-01-16

### 🐛 Fixed

- clear ui schema cache ([#192](https://github.com/tegojs/tego-standard/pull/192)) (@wildworker)


## [0.23.36] - 2025-01-16

### ✨ Added

- menu, search ([#191](https://github.com/tegojs/tego-standard/pull/191)) (@bai.zixv)
- multi app support startAll and stopAll ([#190](https://github.com/tegojs/tego-standard/pull/190)) (@wildworker)


## [0.23.35] - 2025-01-16

### ✨ Added

- menu, search & upload in AdminMenu ([#186](https://github.com/tegojs/tego-standard/pull/186)) (@bai.zixv)
- add a no-pagination option for data query nodes ([#185](https://github.com/tegojs/tego-standard/pull/185)) (@Winc159)
- menu, admin menu ([#184](https://github.com/tegojs/tego-standard/pull/184)) (@bai.zixv)
- sort by belongTo or hasOne field ([#180](https://github.com/tegojs/tego-standard/pull/180)) (@wildworker)
- update css styles fix line break issue and add prompt words ([#179](https://github.com/tegojs/tego-standard/pull/179)) (@Winc159)
- menu, draggable ([#178](https://github.com/tegojs/tego-standard/pull/178)) (@bai.zixv)
- workflow, update & create, attachments, filename ([#177](https://github.com/tegojs/tego-standard/pull/177)) (@bai.zixv)

### 🐛 Fixed

- development plugin not find not allow run ([#188](https://github.com/tegojs/tego-standard/pull/188)) (@wildworker)
- sync mode should intercept when error ([#187](https://github.com/tegojs/tego-standard/pull/187)) (@张琳 Lin Zhang)
- solve block comments can not update ([#183](https://github.com/tegojs/tego-standard/pull/183)) (@Winc159)
- choose iosWeek convert error ([#176](https://github.com/tegojs/tego-standard/pull/176)) (@wildworker)
- redisClient.connect() many times ([#174](https://github.com/tegojs/tego-standard/pull/174)) (@wildworker)

### 🔄 Changed

- **client**: optimize menu toggle open state performance ([#182](https://github.com/tegojs/tego-standard/pull/182)) (@张琳 Lin Zhang)
- log and unsubcribe ([#175](https://github.com/tegojs/tego-standard/pull/175)) (@wildworker)


## [0.23.34] - 2025-01-11

### 🐛 Fixed

- date range null send to server ([#173](https://github.com/tegojs/tego-standard/pull/173)) (@wildworker)


## [0.23.33] - 2025-01-11

### 🐛 Fixed

- audit log createdAt use message not insert time ([#172](https://github.com/tegojs/tego-standard/pull/172)) (@wildworker)
- allow dateRange reset null ([#171](https://github.com/tegojs/tego-standard/pull/171)) (@wildworker)


## [0.23.32] - 2025-01-11

### 🐛 Fixed

- audit log batch, custom request error ([#170](https://github.com/tegojs/tego-standard/pull/170)) (@wildworker)


## [0.23.30] - 2025-01-10

### 🐛 Fixed

- **cloud-component**: some modules could not be found due to unordered loading of cloud components on the server ([#169](https://github.com/tegojs/tego-standard/pull/169)) (@张琳 Lin Zhang)


## [0.23.29] - 2025-01-10

### 🐛 Fixed

- import menu error, custom request origin, test workflow, some process.env.NODE_ENV ([#167](https://github.com/tegojs/tego-standard/pull/167)) (@wildworker)
- chart grouping table field calculation ([#165](https://github.com/tegojs/tego-standard/pull/165)) (@dududuna)
- association field, normal form case ([#168](https://github.com/tegojs/tego-standard/pull/168)) (@bai.zixv)
- fuzzy search action key ([#164](https://github.com/tegojs/tego-standard/pull/164)) (@bai.zixv)

### 🔄 Changed

- user datasource migrate table to tablev2 ([#166](https://github.com/tegojs/tego-standard/pull/166)) (@Winc159)
- migrate user table to table v2 ([#157](https://github.com/tegojs/tego-standard/pull/157)) (@Winc159)


## [0.23.28] - 2025-01-09

### 🐛 Fixed

- custom request can not ignore host ([#162](https://github.com/tegojs/tego-standard/pull/162)) (@wildworker)
- cron locale cache empty ([#161](https://github.com/tegojs/tego-standard/pull/161)) (@wildworker)


## [0.23.27] - 2025-01-09

### ✨ Added

- association field, createEditFormBlockUISchema ([#159](https://github.com/tegojs/tego-standard/pull/159)) (@bai.zixv)

### 🐛 Fixed

- approval, confirm when creat form ([#160](https://github.com/tegojs/tego-standard/pull/160)) (@bai.zixv)

### 🔄 Changed

- approval code ([#144](https://github.com/tegojs/tego-standard/pull/144)) (@bai.zixv)


## [0.23.26] - 2025-01-09

### ✨ Added

- add associations to many to many tables & pdf view hierarchy ([#156](https://github.com/tegojs/tego-standard/pull/156)) (@dududuna)
- menu, setting, change setting design mode ([#155](https://github.com/tegojs/tego-standard/pull/155)) (@bai.zixv)
- setting layout, support location to admin on title ([#153](https://github.com/tegojs/tego-standard/pull/153)) (@bai.zixv)

### 🐛 Fixed

- full text search literal same field error ([#158](https://github.com/tegojs/tego-standard/pull/158)) (@wildworker)
- app event afterStart trigger many times ([#154](https://github.com/tegojs/tego-standard/pull/154)) (@wildworker)
- restore backup over length limit ([#152](https://github.com/tegojs/tego-standard/pull/152)) (@wildworker)


## [0.23.25] - 2025-01-08

### ✨ Added

- fuzzy search note ([#151](https://github.com/tegojs/tego-standard/pull/151)) (@bai.zixv)
- fuzzy search input ([#150](https://github.com/tegojs/tego-standard/pull/150)) (@bai.zixv)
- all fields fuzzy search ([#117](https://github.com/tegojs/tego-standard/pull/117)) (@wildworker)
- notificationprovider migrate table to tablev2 ([#138](https://github.com/tegojs/tego-standard/pull/138)) (@Winc159)
- support select field component ([#139](https://github.com/tegojs/tego-standard/pull/139)) (@bai.zixv)
- otp migrate table to tablev2 ([#135](https://github.com/tegojs/tego-standard/pull/135)) (@Winc159)
- authenticators migrate table to tablev2 ([#141](https://github.com/tegojs/tego-standard/pull/141)) (@Winc159)
- multi app migrate table to tablev2 ([#127](https://github.com/tegojs/tego-standard/pull/127)) (@Winc159)

### 🐛 Fixed

- workflow trigger workflow, context lost ([#149](https://github.com/tegojs/tego-standard/pull/149)) (@wildworker)
- chart classification table allows selection of classification fields ([#145](https://github.com/tegojs/tego-standard/pull/145)) (@dududuna)
- filter the form and click on the configuration field, resulting in an error ([#147](https://github.com/tegojs/tego-standard/pull/147)) (@dududuna)
- db event afterUpdate trigger four times ([#134](https://github.com/tegojs/tego-standard/pull/134)) (@wildworker)
- template association field in record form block ([#143](https://github.com/tegojs/tego-standard/pull/143)) (@bai.zixv)
- allowNewMenu sometimes not work ([#142](https://github.com/tegojs/tego-standard/pull/142)) (@wildworker)
- backup button show better for normal, worker thread help text ([#126](https://github.com/tegojs/tego-standard/pull/126)) (@wildworker)
- tabs style ([#128](https://github.com/tegojs/tego-standard/pull/128)) (@bai.zixv)

### 🔄 Changed

- localization migrate table to table v2 ([#146](https://github.com/tegojs/tego-standard/pull/146)) (@Winc159)


## [0.23.23] - 2025-01-02

### ✨ Added

- openMode error ([#132](https://github.com/tegojs/tego-standard/pull/132)) (@bai.zixv)
- debounce scroll area ([#131](https://github.com/tegojs/tego-standard/pull/131)) (@bai.zixv)
- pdf style ([#129](https://github.com/tegojs/tego-standard/pull/129)) (@bai.zixv)
- show id for node in workflow ([#125](https://github.com/tegojs/tego-standard/pull/125)) (@bai.zixv)
- translate ([#122](https://github.com/tegojs/tego-standard/pull/122)) (@bai.zixv)
- assistant button pluginization and use with pinnedlist ([#118](https://github.com/tegojs/tego-standard/pull/118)) (@Winc159)
- add filter for executions ([#119](https://github.com/tegojs/tego-standard/pull/119)) (@bai.zixv)

### 🐛 Fixed

- side layout overflow ([#130](https://github.com/tegojs/tego-standard/pull/130)) (@bai.zixv)
- worker method reload collection first. module-department to plugin-department ([#124](https://github.com/tegojs/tego-standard/pull/124)) (@wildworker)
- audit log use async after transaction commit ([#116](https://github.com/tegojs/tego-standard/pull/116)) (@wildworker)
- approval, draft shouldn't trigger workflow ([#121](https://github.com/tegojs/tego-standard/pull/121)) (@bai.zixv)
- confirm before close drawer, approval ([#120](https://github.com/tegojs/tego-standard/pull/120)) (@bai.zixv)

### 🔄 Changed

- change approval plugin to new structure ([#99](https://github.com/tegojs/tego-standard/pull/99)) (@bai.zixv)


## [0.23.22] - 2024-12-30

### 🐛 Fixed

- **field-sequence**: tval misuse (@sealday)


## [0.23.21] - 2024-12-30

### ✨ Added

- **client**: restrict filter item initializers level (@sealday)

### 🐛 Fixed

- **field-sequence**: date format cannot config (@sealday)
- add a button backup to explicitly determine whether it is worker ([#114](https://github.com/tegojs/tego-standard/pull/114)) (@wildworker)


## [0.23.20] - 2024-12-29

### ✨ Added

- **web**: data select v1 ([#112](https://github.com/tegojs/tego-standard/pull/112)) (@DYC-zhanglin)

### 🐛 Fixed

- group block request error by rollback axios ([#113](https://github.com/tegojs/tego-standard/pull/113)) (@DYC-zhanglin)
- rest api datasource set fields error, setHeader etag error ([#111](https://github.com/tegojs/tego-standard/pull/111)) (@wildworker)

### 🔄 Changed

- clean up tsconfig.json ([#109](https://github.com/tegojs/tego-standard/pull/109)) (@DYC-zhanglin)


## [0.23.18] - 2024-12-26

### ✨ Added

- ai components and cardization ([#94](https://github.com/tegojs/tego-standard/pull/94)) (@Winc159)

### 🐛 Fixed

- **client**: fix localstorage in ssr ([#107](https://github.com/tegojs/tego-standard/pull/107)) (@DYC-zhanglin)


## [0.23.17] - 2024-12-26

### 🐛 Fixed

- missing devtools (@sealday)


## [0.23.16] - 2024-12-26

### 🐛 Fixed

- pnpm-lock (@sealday)


## [0.23.15] - 2024-12-26

### 🐛 Fixed

- create tachybase app ([#106](https://github.com/tegojs/tego-standard/pull/106)) (@DYC-zhanglin)
- plugin disable after upgrade ([#105](https://github.com/tegojs/tego-standard/pull/105)) (@wildworker)


## [0.23.11] - 2024-12-26

### 🐛 Fixed

- no git check ([#103](https://github.com/tegojs/tego-standard/pull/103)) (@DYC-zhanglin)


## [0.23.10] - 2024-12-26

### 🐛 Fixed

- deps ([#102](https://github.com/tegojs/tego-standard/pull/102)) (@DYC-zhanglin)


## [0.23.9] - 2024-12-26

### ✨ Added

- support data source rest api ([#97](https://github.com/tegojs/tego-standard/pull/97)) (@wildworker)
- add feature list block ([#92](https://github.com/tegojs/tego-standard/pull/92)) (@bai.zixv)
- getLang http返回304,减少请求时间 ([#96](https://github.com/tegojs/tego-standard/pull/96)) (@wildworker)
- add reminder action in approval ([#91](https://github.com/tegojs/tego-standard/pull/91)) (@bai.zixv)

### 🐛 Fixed

- command ([#95](https://github.com/tegojs/tego-standard/pull/95)) (@DYC-zhanglin)
- rest api datasource not show ([#101](https://github.com/tegojs/tego-standard/pull/101)) (@wildworker)
- enable status of new added plugin not work ([#100](https://github.com/tegojs/tego-standard/pull/100)) (@DYC-zhanglin)
- memoized schema in ViewTableMessagesWrapper and reorganize the structure of the component in module-message ([#98](https://github.com/tegojs/tego-standard/pull/98)) (@bai.zixv)


## [0.23.8] - 2024-12-23

### 🐛 Fixed

- add private to demos (@sealday)
- rename hera name ([#87](https://github.com/tegojs/tego-standard/pull/87)) (@DYC-zhanglin)

### 🔄 Changed

- remove turborepo ([#88](https://github.com/tegojs/tego-standard/pull/88)) (@DYC-zhanglin)


## [0.23.7] - 2024-12-21

### ✨ Added

- support worker backup ([#64](https://github.com/tegojs/tego-standard/pull/64)) (@wildworker)

### 🐛 Fixed

- main app stop subapp, can not start by view ([#84](https://github.com/tegojs/tego-standard/pull/84)) (@wildworker)


## [0.23.5] - 2024-12-20

### 🐛 Fixed

- cron job model error, worker thread writeRolesToACL use other repository ([#80](https://github.com/tegojs/tego-standard/pull/80)) (@wildworker)


## [0.23.4] - 2024-12-20

### 🐛 Fixed

- migration workflow error ([#79](https://github.com/tegojs/tego-standard/pull/79)) (@wildworker)


## [0.23.3] - 2024-12-20

### ✨ Added

- hide or show scroll area logic for context menu ([#72](https://github.com/tegojs/tego-standard/pull/72)) (@bai.zixv)
- dev can wait server ([#73](https://github.com/tegojs/tego-standard/pull/73)) (@DYC-zhanglin)

### 🐛 Fixed

- build tsup ([#69](https://github.com/tegojs/tego-standard/pull/69)) (@DYC-zhanglin)


## [0.23.2] - 2024-12-20

### 🐛 Fixed

- lazy load ([#67](https://github.com/tegojs/tego-standard/pull/67)) (@DYC-zhanglin)


## [0.23.1] - 2024-12-20

### 🐛 Fixed

- docker images ([#65](https://github.com/tegojs/tego-standard/pull/65)) (@DYC-zhanglin)


## [0.23.0] - 2024-12-20

### 🐛 Fixed

- cron jobs table (@sealday)
- bigint migration ([#62](https://github.com/tegojs/tego-standard/pull/62)) (@wildworker)
- locale, db bigint safe ([#60](https://github.com/tegojs/tego-standard/pull/60)) (@wildworker)

### 🔄 Changed

- migrate to rsbuild ([#63](https://github.com/tegojs/tego-standard/pull/63)) (@DYC-zhanglin)
- move plugin-file-manager to module-file ([#61](https://github.com/tegojs/tego-standard/pull/61)) (@DYC-zhanglin)


## [0.22.85] - 2024-12-19

### ✨ Added

- add current form variables in workflow code mirror & messageVariables in message ([#58](https://github.com/tegojs/tego-standard/pull/58)) (@bai.zixv)
- add execution time to job node ([#55](https://github.com/tegojs/tego-standard/pull/55)) (@Winc159)
- **message**: message sms logic ([#54](https://github.com/tegojs/tego-standard/pull/54)) (@bai.zixv)
- init rsbuild support ([#50](https://github.com/tegojs/tego-standard/pull/50)) (@DYC-zhanglin)
- **workflow**: handle deprecated nodes to make them easier to find ([#46](https://github.com/tegojs/tego-standard/pull/46)) (@bai.zixv)
- **workflow**: add ShowNodeTypesInWorkflow component to display node types in workflow ([#44](https://github.com/tegojs/tego-standard/pull/44)) (@bai.zixv)
- controll worker thread count on web, worker error limit ([#41](https://github.com/tegojs/tego-standard/pull/41)) (@wildworker)

### 🐛 Fixed

- router-error ([#57](https://github.com/tegojs/tego-standard/pull/57)) (@wildworker)
- lock file (@sealday)
- data source not show ([#53](https://github.com/tegojs/tego-standard/pull/53)) (@wildworker)
- folding panel creates tree table error ([#51](https://github.com/tegojs/tego-standard/pull/51)) #40 (@dududuna)
- change plugin name verification to otp ([#52](https://github.com/tegojs/tego-standard/pull/52)) (@bai.zixv)
- cron job memory leak ([#47](https://github.com/tegojs/tego-standard/pull/47)) (@wildworker)
- uiSchema remove action happened to encounter CRUD operations ([#45](https://github.com/tegojs/tego-standard/pull/45)) (@wildworker)
- default behavior for filtering text is eq ([#43](https://github.com/tegojs/tego-standard/pull/43)) (@dududuna)
- **workflow**: multiple historical records in the workflow are not displayed & fix(workflow): compatibility problem with workflow module ([#42](https://github.com/tegojs/tego-standard/pull/42)) (@bai.zixv)

### 🔄 Changed

- **messge**: refactoring the code to make registration management more easily ([#49](https://github.com/tegojs/tego-standard/pull/49)) (@bai.zixv)


## [0.22.84] - 2024-12-18

### 🐛 Fixed

- module cron locale, cron set, use execution log ([#36](https://github.com/tegojs/tego-standard/pull/36)) (@wildworker)

### 🔄 Changed

- workflows  support tags ([#37](https://github.com/tegojs/tego-standard/pull/37)) (@DYC-zhanglin)


## [0.22.83] - 2024-12-17

### ✨ Added

- **devtools**: init plugin ([#33](https://github.com/tegojs/tego-standard/pull/33)) (@Winc159)

### 🐛 Fixed

- editor readonly error, worker not suppport subApp ([#35](https://github.com/tegojs/tego-standard/pull/35)) (@wildworker)
- default values that should not appear in the table ([#32](https://github.com/tegojs/tego-standard/pull/32)) (@dududuna)

### 🔄 Changed

- remove unused code ([#34](https://github.com/tegojs/tego-standard/pull/34)) (@bai.zixv)


## [0.22.82] - 2024-12-17

### 🐛 Fixed

- getPluginMethodKey params error ([#30](https://github.com/tegojs/tego-standard/pull/30)) (@wildworker)
- **client**: debug mode edit ([#28](https://github.com/tegojs/tego-standard/pull/28)) (@DYC-zhanglin)

### 📝 Documentation

- show how to upgrade from old version (@sealday)


## [0.22.81] - 2024-12-16

### 🐛 Fixed

- @tachybase/module-data-source-manager build errors and i18n problems ([#27](https://github.com/tegojs/tego-standard/pull/27)) (@DYC-zhanglin)


## [0.22.75] - 2024-12-16

### ✨ Added

- support pg_client, zip in image ([#1913](https://github.com/tegojs/tego-standard/pull/1913)) (@Toby)


## [0.22.72] - 2024-12-16

### ✨ Added

- **client**: optimize the debugging experience (@sealday)
- work wechat use mobile for unique key ([#1904](https://github.com/tegojs/tego-standard/pull/1904)) (@Toby)
- add WorkflowVariableCodeMirror & others fix in workflow and site-messages ([#1890](https://github.com/tegojs/tego-standard/pull/1890)) (@bai.zixv)
- toposort support unique option ([#1902](https://github.com/tegojs/tego-standard/pull/1902)) (@sealday)

### 🐛 Fixed

- worker thread production start error ([#1909](https://github.com/tegojs/tego-standard/pull/1909)) (@Toby)
- i18n (@sealday)
- worker thread (@sealday)
- admin settings layout jump ([#1903](https://github.com/tegojs/tego-standard/pull/1903)) (@sealday)
- resource events being added repeatedly ([#1900](https://github.com/tegojs/tego-standard/pull/1900)) (@sealday)
- build warnings ([#1899](https://github.com/tegojs/tego-standard/pull/1899)) (@sealday)

### 🔄 Changed

- module web ([#1908](https://github.com/tegojs/tego-standard/pull/1908)) (@sealday)
- rename packages ([#1907](https://github.com/tegojs/tego-standard/pull/1907)) (@sealday)
- unify @formily/x ([#1906](https://github.com/tegojs/tego-standard/pull/1906)) (@sealday)
- approval ui & system setting translations ([#1905](https://github.com/tegojs/tego-standard/pull/1905)) (@sealday)


## [0.22.69] - 2024-12-13

### ✨ Added

- cron job plugin to use workflow, not trigger type ([#1883](https://github.com/tegojs/tego-standard/pull/1883)) (@Toby)
- **client**: new style system settings ([#1889](https://github.com/tegojs/tego-standard/pull/1889)) (@sealday)
- menu-like filter (WIP) ([#1888](https://github.com/tegojs/tego-standard/pull/1888)) (@sealday)
- site message ([#1856](https://github.com/tegojs/tego-standard/pull/1856)) (@bai.zixv)
- event source support middlewares ([#1885](https://github.com/tegojs/tego-standard/pull/1885)) (@sealday)

### 🐛 Fixed

- name error (@sealday)
- init app not load roles (@sealday)
- module not found (@sealday)
- **client**: system settings ([#1894](https://github.com/tegojs/tego-standard/pull/1894)) (@sealday)
- extern pg not show uppercase table ([#1893](https://github.com/tegojs/tego-standard/pull/1893)) (@Toby)
- **client**: navigate errors ([#1892](https://github.com/tegojs/tego-standard/pull/1892)) (@sealday)
- multi app create error, need default preset ([#1891](https://github.com/tegojs/tego-standard/pull/1891)) (@Toby)
- package-name error (@sealday)
- module export (@sealday)
- import errors ([#1887](https://github.com/tegojs/tego-standard/pull/1887)) (@sealday)
- migration of hera hook to workflow ([#1882](https://github.com/tegojs/tego-standard/pull/1882)) (@wjh)
- **server**: ignore some load error (@sealday)

### 🔄 Changed

- rename certain package names to better reflect their actual intent ([#1896](https://github.com/tegojs/tego-standard/pull/1896)) (@sealday)
- **data-source**: datasource migrate table to table-v2 ([#1881](https://github.com/tegojs/tego-standard/pull/1881)) (@WinC159)
- merge mobile client to client ([#1886](https://github.com/tegojs/tego-standard/pull/1886)) (@sealday)
- clean codes ([#1884](https://github.com/tegojs/tego-standard/pull/1884)) (@sealday)

### 📝 Documentation

- update readme (@sealday)
- update readme.md (@sealday)
- update readme (@sealday)
- fix png (@sealday)
- add some cases (@sealday)


## [0.22.62] - 2024-12-09

### ✨ Added

- add columns in workflow table ([#1874](https://github.com/tegojs/tego-standard/pull/1874)) (@bai.zixv)
- event source add db event ([#1873](https://github.com/tegojs/tego-standard/pull/1873)) (@sealday)
- gap button area ([#1869](https://github.com/tegojs/tego-standard/pull/1869)) (@bai.zixv)
- **cloud-component**: support client preload pdf ([#1859](https://github.com/tegojs/tego-standard/pull/1859)) (@sealday)
- **acl**: generate a virtual character for each user, formed by merging all their current roles ([#1838](https://github.com/tegojs/tego-standard/pull/1838)) (@Toby)
- **workflow**: beauty node in workflow, history ([#1852](https://github.com/tegojs/tego-standard/pull/1852)) (@bai.zixv)
- **workflow**: beautify node in workflow ([#1848](https://github.com/tegojs/tego-standard/pull/1848)) (@bai.zixv)
- cloud component support in table/details/form ([#1845](https://github.com/tegojs/tego-standard/pull/1845)) (@sealday)
- init block item toolbar(technical preview) ([#1842](https://github.com/tegojs/tego-standard/pull/1842)) (@sealday)
- add collection column in workflow table ([#1839](https://github.com/tegojs/tego-standard/pull/1839)) (@bai.zixv)
- **workflow-approval**: change summary search implementation ([#1835](https://github.com/tegojs/tego-standard/pull/1835)) (@bai.zixv)
- **cloud-component**: client plugin ([#1837](https://github.com/tegojs/tego-standard/pull/1837)) (@sealday)
- **cloud-component**: server part ([#1825](https://github.com/tegojs/tego-standard/pull/1825)) (@sealday)
- **field-encryption**: add plugin ([#1834](https://github.com/tegojs/tego-standard/pull/1834)) (@bai.zixv)
- filemanger migrate table to  tablev2 ([#1827](https://github.com/tegojs/tego-standard/pull/1827)) (@fanyukun)
- **workflow**: add code comment in CodeMirror ([#1829](https://github.com/tegojs/tego-standard/pull/1829)) (@bai.zixv)
- **event-source**: add comment in CodeMirror ([#1828](https://github.com/tegojs/tego-standard/pull/1828)) (@bai.zixv)
- **event-source**: sync custom event sources ([#1802](https://github.com/tegojs/tego-standard/pull/1802)) (@bai.zixv)
- **workflow**: workflow, style ([#1822](https://github.com/tegojs/tego-standard/pull/1822)) (@bai.zixv)
- block only show self multi app ([#1823](https://github.com/tegojs/tego-standard/pull/1823)) (@Toby)
- **client**: page mode ([#1810](https://github.com/tegojs/tego-standard/pull/1810)) (@sealday)
- **approval**: add approvalId in h5 ([#1821](https://github.com/tegojs/tego-standard/pull/1821)) (@bai.zixv)
- **messages**: init support for messages ([#1819](https://github.com/tegojs/tego-standard/pull/1819)) (@Toby)
- display execution history node data in a codemirror with quick copy support ([#1818](https://github.com/tegojs/tego-standard/pull/1818)) (@fanyukun)
- beautify workflow node ([#1816](https://github.com/tegojs/tego-standard/pull/1816)) (@bai.zixv)
- workflow-add-retryexecution-funtion ([#1815](https://github.com/tegojs/tego-standard/pull/1815)) (@fanyukun)
- split NodeDefaultView ([#1814](https://github.com/tegojs/tego-standard/pull/1814)) (@bai.zixv)
- add auth page plugin and rename packages ([#1809](https://github.com/tegojs/tego-standard/pull/1809)) (@sealday)
- layout header style shadow ([#1808](https://github.com/tegojs/tego-standard/pull/1808)) (@bai.zixv)
- add workflow testing ([#1806](https://github.com/tegojs/tego-standard/pull/1806)) (@sealday)
- full-functional-scripts ([#1803](https://github.com/tegojs/tego-standard/pull/1803)) (@sealday)
- theme light mode about CodeMirror ([#1801](https://github.com/tegojs/tego-standard/pull/1801)) (@bai.zixv)
- add script to modify database schema due to client code upgrade ([#1793](https://github.com/tegojs/tego-standard/pull/1793)) (@Toby)
- **workflow**: execution time column ([#1797](https://github.com/tegojs/tego-standard/pull/1797)) (@fanyukun)
- **event-source**: init support resource define ([#1798](https://github.com/tegojs/tego-standard/pull/1798)) (@sealday)
- **approval**: support search id ([#1795](https://github.com/tegojs/tego-standard/pull/1795)) (@bai.zixv)
- init turbo build support ([#1791](https://github.com/tegojs/tego-standard/pull/1791)) (@sealday)
- new spin ([#1786](https://github.com/tegojs/tego-standard/pull/1786)) (@sealday)
- schema initializer support waitlist ([#1785](https://github.com/tegojs/tego-standard/pull/1785)) (@sealday)
- **approval**: change Table -> TableV2 in approval plugin ([#1781](https://github.com/tegojs/tego-standard/pull/1781)) (@bai.zixv)
- action decorator support acl options ([#1774](https://github.com/tegojs/tego-standard/pull/1774)) (@sealday)
- workflows sort by init time not by current create time ([#1768](https://github.com/tegojs/tego-standard/pull/1768)) (@Toby)
- init pdf module and refactor workflow module ([#1765](https://github.com/tegojs/tego-standard/pull/1765)) (@sealday)
- **client**: add scroll area to page ([#1755](https://github.com/tegojs/tego-standard/pull/1755)) (@bai.zixv)
- **approval**: fuzzy approval search ([#1760](https://github.com/tegojs/tego-standard/pull/1760)) (@bai.zixv)
- adjust pop-up label storage ([#1753](https://github.com/tegojs/tego-standard/pull/1753)) (@wjh)
- **auth**: user binding mechanism and wechat verification now support user binding ([#1740](https://github.com/tegojs/tego-standard/pull/1740)) (@Toby)
- **scripts**: detect empty project folders ([#1744](https://github.com/tegojs/tego-standard/pull/1744)) (@fanyukun)
- experimental support for mako ([#1747](https://github.com/tegojs/tego-standard/pull/1747)) (@sealday)
- **approval**: search in summary ([#1741](https://github.com/tegojs/tego-standard/pull/1741)) (@bai.zixv)
- dynamic schema props decorator ([#1742](https://github.com/tegojs/tego-standard/pull/1742)) (@sealday)
- add scripts to check whether the package names are correct and provide automatic corrections for incorrect package names. ([#1734](https://github.com/tegojs/tego-standard/pull/1734)) (@fanyukun)
- 结算单计算触发工作流 ([#1733](https://github.com/tegojs/tego-standard/pull/1733)) (@wjh)
- **scripts**: add check names scripts ([#1732](https://github.com/tegojs/tego-standard/pull/1732)) (@sealday)
- workflow zoom state and splitter size state can saved now ([#1725](https://github.com/tegojs/tego-standard/pull/1725)) (@sealday)
- 添加工作流分支状态&合同状态更新脚本 ([#1721](https://github.com/tegojs/tego-standard/pull/1721)) (@wjh)
- workflow add moveUp and moveDown ([#1724](https://github.com/tegojs/tego-standard/pull/1724)) (@sealday)
- **workflow**: add refresh and filter to workflow table ([#1716](https://github.com/tegojs/tego-standard/pull/1716)) (@bai.zixv)
- **tb**: support sorting of context menu items ([#1714](https://github.com/tegojs/tego-standard/pull/1714)) (@bai.zixv)
- add demo app ([#1712](https://github.com/tegojs/tego-standard/pull/1712)) (@sealday)
- fix package json ([#1711](https://github.com/tegojs/tego-standard/pull/1711)) (@bai.zixv)
- add clean command to remove all files ([#1710](https://github.com/tegojs/tego-standard/pull/1710)) (@sealday)
- 系统设置访问保持公开 ([#1706](https://github.com/tegojs/tego-standard/pull/1706)) (@bai.zixv)
- support interaction and calling between different workflows ([#1692](https://github.com/tegojs/tego-standard/pull/1692)) (@Toby)
- 更改翻译文案 ([#1704](https://github.com/tegojs/tego-standard/pull/1704)) (@bai.zixv)
- **departments**: support show all members ([#1686](https://github.com/tegojs/tego-standard/pull/1686)) (@Toby)
- experimental support for react-based PDF rendering ([#1703](https://github.com/tegojs/tego-standard/pull/1703)) (@sealday)
- move use repository.update ([#1689](https://github.com/tegojs/tego-standard/pull/1689)) (@Toby)
- add demo game block runesweeper ([#1684](https://github.com/tegojs/tego-standard/pull/1684)) (@sealday)
- svg类型图片预览 ([#1669](https://github.com/tegojs/tego-standard/pull/1669)) (@wjh)
- add multi app manager block ([#1668](https://github.com/tegojs/tego-standard/pull/1668)) (@Toby)
- new menu ui ([#1664](https://github.com/tegojs/tego-standard/pull/1664)) (@sealday)
- **approval**: add translate text ([#1658](https://github.com/tegojs/tego-standard/pull/1658)) (@bai.zixv)
- 结算单新增期限免租&最短租期计算方式 ([#1651](https://github.com/tegojs/tego-standard/pull/1651)) (@wjh)
- scroll-assistant now support wheel event ([#1654](https://github.com/tegojs/tego-standard/pull/1654)) (@sealday)
- **tb**: update icon ([#1648](https://github.com/tegojs/tego-standard/pull/1648)) (@bai.zixv)

### 🐛 Fixed

- migration of hera hook to workflow ([#1875](https://github.com/tegojs/tego-standard/pull/1875)) (@wjh)
- revert to old tooltip version (@sealday)
- after start database instance not found (@sealday)
- container can not load controller when init (@sealday)
- dev using relative path for easier copying (@sealday)
- change link to tachybase (@sealday)
- web service not load when hera not load ([#1876](https://github.com/tegojs/tego-standard/pull/1876)) (@sealday)
- version check (@sealday)
- node in history ([#1872](https://github.com/tegojs/tego-standard/pull/1872)) (@bai.zixv)
- **cloud-component**: schema conflict issue between cloud components and event sources ([#1870](https://github.com/tegojs/tego-standard/pull/1870)) (@sealday)
- node in history ([#1868](https://github.com/tegojs/tego-standard/pull/1868)) (@bai.zixv)
- migration of hera hook to workflow ([#1862](https://github.com/tegojs/tego-standard/pull/1862)) (@wjh)
- **department**: department show all member error, can not remove department from role ([#1860](https://github.com/tegojs/tego-standard/pull/1860)) (@Toby)
- migration of hera front end components  to cloud component ([#1858](https://github.com/tegojs/tego-standard/pull/1858)) (@wjh)
- migration of hera custom component to cloud component ([#1853](https://github.com/tegojs/tego-standard/pull/1853)) (@wjh)
- **cloud-component**: load packages when dev ([#1854](https://github.com/tegojs/tego-standard/pull/1854)) (@sealday)
- **client**: recursive component only displays the innermost toolbar (@sealday)
- **cloud-component**: can not load memo function ([#1850](https://github.com/tegojs/tego-standard/pull/1850)) (@sealday)
- cloud component enable error ([#1847](https://github.com/tegojs/tego-standard/pull/1847)) (@Toby)
- kanban (@sealday)
- **cloud-component**: table effect immediately (@sealday)
- cloud component works in table (@sealday)
- designable work for new style toolbar ([#1846](https://github.com/tegojs/tego-standard/pull/1846)) (@sealday)
- **cloud-component**: auth errors ([#1841](https://github.com/tegojs/tego-standard/pull/1841)) (@sealday)
- **approval**: fuzzySearch params error ([#1840](https://github.com/tegojs/tego-standard/pull/1840)) (@bai.zixv)
- **client**: display repeat create success message ([#1831](https://github.com/tegojs/tego-standard/pull/1831)) (@fanyukun)
- add record is_end field ([#1833](https://github.com/tegojs/tego-standard/pull/1833)) (@wjh)
- **export**: pre count before find ([#1832](https://github.com/tegojs/tego-standard/pull/1832)) (@Toby)
- **collection-manager**: import table no longer import categories, and import failures do not refresh the page ([#1830](https://github.com/tegojs/tego-standard/pull/1830)) (@Toby)
- **acl**: message: ACL error, multi-app should grant the "list" permission to loggedIn ([#1826](https://github.com/tegojs/tego-standard/pull/1826)) (@Toby)
- template only get owner or admin set ([#1824](https://github.com/tegojs/tego-standard/pull/1824)) (@Toby)
- settlement statement does not trigger voucher automatic update ([#1820](https://github.com/tegojs/tego-standard/pull/1820)) (@wjh)
- acl [view,update,destroy] check include many include lead to cpu crash ([#1817](https://github.com/tegojs/tego-standard/pull/1817)) (@Toby)
- readonly bug ([#1812](https://github.com/tegojs/tego-standard/pull/1812)) (@bai.zixv)
- pdf logger ([#1811](https://github.com/tegojs/tego-standard/pull/1811)) (@sealday)
- revert mako default ([#1805](https://github.com/tegojs/tego-standard/pull/1805)) (@sealday)
- unique key approvalProvider ([#1800](https://github.com/tegojs/tego-standard/pull/1800)) (@bai.zixv)
- adjust SVG component ([#1799](https://github.com/tegojs/tego-standard/pull/1799)) (@wjh)
- linkage rule lead to many times request ([#1792](https://github.com/tegojs/tego-standard/pull/1792)) (@bai.zixv)
- **approval**: approval ApprovalBlock.Launch.Application ([#1788](https://github.com/tegojs/tego-standard/pull/1788)) (@bai.zixv)
- moudle pdf build ([#1787](https://github.com/tegojs/tego-standard/pull/1787)) (@sealday)
- workflow approval mobile plugin removal ([#1782](https://github.com/tegojs/tego-standard/pull/1782)) (@sealday)
- **approval**: translate namespace ([#1780](https://github.com/tegojs/tego-standard/pull/1780)) (@bai.zixv)
- workflow view history nodes & configure and add category keys ([#1776](https://github.com/tegojs/tego-standard/pull/1776)) (@wjh)
- module i18n ([#1770](https://github.com/tegojs/tego-standard/pull/1770)) (@sealday)
- **client**: scroll ([#1771](https://github.com/tegojs/tego-standard/pull/1771)) (@bai.zixv)
- module pdf and event source should be enabled default ([#1767](https://github.com/tegojs/tego-standard/pull/1767)) (@sealday)
- same auth public can not be overwrite by loggedIn ([#1764](https://github.com/tegojs/tego-standard/pull/1764)) (@Toby)
- calculation of settlement statement fees & PDF view ([#1763](https://github.com/tegojs/tego-standard/pull/1763)) (@wjh)
- **approval**: useSubmit form status fixed ([#1762](https://github.com/tegojs/tego-standard/pull/1762)) (@bai.zixv)
- controller init fails ([#1758](https://github.com/tegojs/tego-standard/pull/1758)) (@sealday)
- getUserInfo to show bind nickname, limit sign in timeout (@Toby)
- proxy port failed (@sealday)
- date adaptation of mobile tab-search component ([#1746](https://github.com/tegojs/tego-standard/pull/1746)) (@wjh)
- pdf-viewer scrollable in pc and refactor mobile-provider ([#1739](https://github.com/tegojs/tego-standard/pull/1739)) (@sealday)
- type errors when useTranslation ([#1736](https://github.com/tegojs/tego-standard/pull/1736)) (@sealday)
- umi module find fails ([#1731](https://github.com/tegojs/tego-standard/pull/1731)) (@sealday)
- ignore rental upgrade errors ([#1730](https://github.com/tegojs/tego-standard/pull/1730)) (@sealday)
- 修改结算单关联赔偿支持订单金额 ([#1727](https://github.com/tegojs/tego-standard/pull/1727)) (@wjh)
- dont change workflow node key when move up ([#1728](https://github.com/tegojs/tego-standard/pull/1728)) (@sealday)
- workflow save state by type ([#1726](https://github.com/tegojs/tego-standard/pull/1726)) (@sealday)
- cli and docker file path error ([#1722](https://github.com/tegojs/tego-standard/pull/1722)) (@Toby)
- **approval**: fix approval show amount error (@bai.zixv)
- viewport, meta scalesize, 1.0 ([#1713](https://github.com/tegojs/tego-standard/pull/1713)) (@bai.zixv)
- **approval**: forbidden trigger workflow when some status changed ([#1709](https://github.com/tegojs/tego-standard/pull/1709)) (@bai.zixv)
- cloud component can now run in both dev and prod environment ([#1702](https://github.com/tegojs/tego-standard/pull/1702)) (@sealday)
- **page-tab**: stopPropagation on close tag ([#1700](https://github.com/tegojs/tego-standard/pull/1700)) (@bai.zixv)
- quickstart ([#1696](https://github.com/tegojs/tego-standard/pull/1696)) (@sealday)
- 完善欢迎卡片 ([#1695](https://github.com/tegojs/tego-standard/pull/1695)) (@bai.zixv)
- 修复结算单最短租期显示 ([#1691](https://github.com/tegojs/tego-standard/pull/1691)) (@wjh)
- 工作流内嵌弹窗样式问题 ([#1687](https://github.com/tegojs/tego-standard/pull/1687)) (@wjh)
- tab panel reset after switch to other tab ([#1690](https://github.com/tegojs/tego-standard/pull/1690)) (@sealday)
- docker-entrypoint ([#1685](https://github.com/tegojs/tego-standard/pull/1685)) (@sealday)
- sentry path error ([#1682](https://github.com/tegojs/tego-standard/pull/1682)) (@sealday)
- pdf dist files ([#1679](https://github.com/tegojs/tego-standard/pull/1679)) (@sealday)
- **approval**: approval todos show process component bug ([#1674](https://github.com/tegojs/tego-standard/pull/1674)) (@bai.zixv)
- graph migration ([#1675](https://github.com/tegojs/tego-standard/pull/1675)) (@sealday)
- action sheet translations ([#1673](https://github.com/tegojs/tego-standard/pull/1673)) (@sealday)
- limit excel export & date format to string with client timezone ([#1661](https://github.com/tegojs/tego-standard/pull/1661)) (@Toby)
- 修改下拉框设置默认值不生效 ([#1662](https://github.com/tegojs/tego-standard/pull/1662)) (@wjh)
- **tb**: 修复平板设备过于缩小问题 ([#1655](https://github.com/tegojs/tego-standard/pull/1655)) (@bai.zixv)
- 修复工作流审批节点保存报错 ([#1653](https://github.com/tegojs/tego-standard/pull/1653)) (@wjh)
- **client**: submenu display empty label ([#1652](https://github.com/tegojs/tego-standard/pull/1652)) (@sealday)

### 🔄 Changed

- **hera**: clean codes ([#1880](https://github.com/tegojs/tego-standard/pull/1880)) (@sealday)
- remove unused notifications modules (@sealday)
- remove prototype pdf editor (merged into cloud components) (@sealday)
- **hera**: clean codes ([#1865](https://github.com/tegojs/tego-standard/pull/1865)) (@sealday)
- add custom icon for node ([#1855](https://github.com/tegojs/tego-standard/pull/1855)) (@bai.zixv)
- rename packages ([#1844](https://github.com/tegojs/tego-standard/pull/1844)) (@sealday)
- workflow module, split default node view ([#1813](https://github.com/tegojs/tego-standard/pull/1813)) (@bai.zixv)
- **client**: migrate useCreateActionProps & submit button operation from hera to client ([#1789](https://github.com/tegojs/tego-standard/pull/1789)) (@wjh)
- **workflow**: workflow execution move to table v2 ([#1790](https://github.com/tegojs/tego-standard/pull/1790)) (@fanyukun)
- approval ([#1796](https://github.com/tegojs/tego-standard/pull/1796)) (@bai.zixv)
- approval ([#1794](https://github.com/tegojs/tego-standard/pull/1794)) (@bai.zixv)
- remove compatible schema ([#1784](https://github.com/tegojs/tego-standard/pull/1784)) (@sealday)
- **workflow**: workflow migrate Table to TableV2 ([#1761](https://github.com/tegojs/tego-standard/pull/1761)) (@fanyukun)
- **approval**: rename package ([#1779](https://github.com/tegojs/tego-standard/pull/1779)) (@sealday)
- notice area with antd alert component ([#1775](https://github.com/tegojs/tego-standard/pull/1775)) (@sealday)
- approval ([#1772](https://github.com/tegojs/tego-standard/pull/1772)) (@bai.zixv)
- approval ([#1769](https://github.com/tegojs/tego-standard/pull/1769)) (@bai.zixv)
- **approval**: approval ([#1749](https://github.com/tegojs/tego-standard/pull/1749)) (@bai.zixv)
- **client**: separate out requirejs ([#1754](https://github.com/tegojs/tego-standard/pull/1754)) (@sealday)
- **client**: tachybase client self ref ([#1748](https://github.com/tegojs/tego-standard/pull/1748)) (@sealday)
- **approval**: approval block launch schema ([#1735](https://github.com/tegojs/tego-standard/pull/1735)) (@bai.zixv)
- rename to modules ([#1729](https://github.com/tegojs/tego-standard/pull/1729)) (@sealday)
- change js to ts (@sealday)
- change approval file name ([#1720](https://github.com/tegojs/tego-standard/pull/1720)) (@bai.zixv)
- **approval**: change approval file ([#1719](https://github.com/tegojs/tego-standard/pull/1719)) (@bai.zixv)
- **lint**: remove unused lint deps ([#1718](https://github.com/tegojs/tego-standard/pull/1718)) (@sealday)
- mv apps from packages to apps ([#1708](https://github.com/tegojs/tego-standard/pull/1708)) (@sealday)
- ai assistant and cloud components ([#1694](https://github.com/tegojs/tego-standard/pull/1694)) (@sealday)
- mv @hera plugins to @tachybase namespaces ([#1683](https://github.com/tegojs/tego-standard/pull/1683)) (@sealday)
- data source ([#1665](https://github.com/tegojs/tego-standard/pull/1665)) (@sealday)
- 重构下拉菜单，统一模态窗和抽屉的 UI，新增快捷入口区块 ([#1649](https://github.com/tegojs/tego-standard/pull/1649)) (@sealday)
- **approval**: migrate approval plugin ([#1773](https://github.com/tegojs/tego-standard/pull/1773)) (@bai.zixv)
- improve lint ([#1717](https://github.com/tegojs/tego-standard/pull/1717)) (@sealday)
- 工作流 HTTP给个写备注的地方. 以防后续不知道节点数据含义 ([#1672](https://github.com/tegojs/tego-standard/pull/1672)) (@Toby)

### 📝 Documentation

- update readme (@sealday)
- update readme (@sealday)
- update readme (@sealday)
- update readme (@sealday)
- update README.md (@sealday)
- readme.md (@sealday)
- update readme.md (@sealday)
- update readme.md ([#1807](https://github.com/tegojs/tego-standard/pull/1807)) (@sealday)
- update readme.md (@sealday)
- update readme ([#1756](https://github.com/tegojs/tego-standard/pull/1756)) (@sealday)
- update license (@sealday)
- update readme.md (@sealday)
- update readme.md ([#1751](https://github.com/tegojs/tego-standard/pull/1751)) (@sealday)
- update readme ([#1663](https://github.com/tegojs/tego-standard/pull/1663)) (@sealday)
- update readme ([#1656](https://github.com/tegojs/tego-standard/pull/1656)) (@sealday)


## [0.0.3] - 2024-12-16

### ✨ Added

- support pg_client, zip in image ([#1913](https://github.com/tegojs/tego-standard/pull/1913)) (@Toby)
- **client**: optimize the debugging experience (@sealday)
- work wechat use mobile for unique key ([#1904](https://github.com/tegojs/tego-standard/pull/1904)) (@Toby)
- add WorkflowVariableCodeMirror & others fix in workflow and site-messages ([#1890](https://github.com/tegojs/tego-standard/pull/1890)) (@bai.zixv)
- toposort support unique option ([#1902](https://github.com/tegojs/tego-standard/pull/1902)) (@sealday)
- cron job plugin to use workflow, not trigger type ([#1883](https://github.com/tegojs/tego-standard/pull/1883)) (@Toby)
- **client**: new style system settings ([#1889](https://github.com/tegojs/tego-standard/pull/1889)) (@sealday)
- menu-like filter (WIP) ([#1888](https://github.com/tegojs/tego-standard/pull/1888)) (@sealday)
- site message ([#1856](https://github.com/tegojs/tego-standard/pull/1856)) (@bai.zixv)
- event source support middlewares ([#1885](https://github.com/tegojs/tego-standard/pull/1885)) (@sealday)
- add columns in workflow table ([#1874](https://github.com/tegojs/tego-standard/pull/1874)) (@bai.zixv)
- event source add db event ([#1873](https://github.com/tegojs/tego-standard/pull/1873)) (@sealday)
- gap button area ([#1869](https://github.com/tegojs/tego-standard/pull/1869)) (@bai.zixv)
- **cloud-component**: support client preload pdf ([#1859](https://github.com/tegojs/tego-standard/pull/1859)) (@sealday)
- **acl**: generate a virtual character for each user, formed by merging all their current roles ([#1838](https://github.com/tegojs/tego-standard/pull/1838)) (@Toby)
- **workflow**: beauty node in workflow, history ([#1852](https://github.com/tegojs/tego-standard/pull/1852)) (@bai.zixv)
- **workflow**: beautify node in workflow ([#1848](https://github.com/tegojs/tego-standard/pull/1848)) (@bai.zixv)
- cloud component support in table/details/form ([#1845](https://github.com/tegojs/tego-standard/pull/1845)) (@sealday)
- init block item toolbar(technical preview) ([#1842](https://github.com/tegojs/tego-standard/pull/1842)) (@sealday)
- add collection column in workflow table ([#1839](https://github.com/tegojs/tego-standard/pull/1839)) (@bai.zixv)
- **workflow-approval**: change summary search implementation ([#1835](https://github.com/tegojs/tego-standard/pull/1835)) (@bai.zixv)
- **cloud-component**: client plugin ([#1837](https://github.com/tegojs/tego-standard/pull/1837)) (@sealday)
- **cloud-component**: server part ([#1825](https://github.com/tegojs/tego-standard/pull/1825)) (@sealday)
- **field-encryption**: add plugin ([#1834](https://github.com/tegojs/tego-standard/pull/1834)) (@bai.zixv)
- filemanger migrate table to  tablev2 ([#1827](https://github.com/tegojs/tego-standard/pull/1827)) (@fanyukun)
- **workflow**: add code comment in CodeMirror ([#1829](https://github.com/tegojs/tego-standard/pull/1829)) (@bai.zixv)
- **event-source**: add comment in CodeMirror ([#1828](https://github.com/tegojs/tego-standard/pull/1828)) (@bai.zixv)
- **event-source**: sync custom event sources ([#1802](https://github.com/tegojs/tego-standard/pull/1802)) (@bai.zixv)
- **workflow**: workflow, style ([#1822](https://github.com/tegojs/tego-standard/pull/1822)) (@bai.zixv)
- block only show self multi app ([#1823](https://github.com/tegojs/tego-standard/pull/1823)) (@Toby)
- **client**: page mode ([#1810](https://github.com/tegojs/tego-standard/pull/1810)) (@sealday)
- **approval**: add approvalId in h5 ([#1821](https://github.com/tegojs/tego-standard/pull/1821)) (@bai.zixv)
- **messages**: init support for messages ([#1819](https://github.com/tegojs/tego-standard/pull/1819)) (@Toby)
- display execution history node data in a codemirror with quick copy support ([#1818](https://github.com/tegojs/tego-standard/pull/1818)) (@fanyukun)
- beautify workflow node ([#1816](https://github.com/tegojs/tego-standard/pull/1816)) (@bai.zixv)
- workflow-add-retryexecution-funtion ([#1815](https://github.com/tegojs/tego-standard/pull/1815)) (@fanyukun)
- split NodeDefaultView ([#1814](https://github.com/tegojs/tego-standard/pull/1814)) (@bai.zixv)
- add auth page plugin and rename packages ([#1809](https://github.com/tegojs/tego-standard/pull/1809)) (@sealday)
- layout header style shadow ([#1808](https://github.com/tegojs/tego-standard/pull/1808)) (@bai.zixv)
- add workflow testing ([#1806](https://github.com/tegojs/tego-standard/pull/1806)) (@sealday)
- full-functional-scripts ([#1803](https://github.com/tegojs/tego-standard/pull/1803)) (@sealday)
- theme light mode about CodeMirror ([#1801](https://github.com/tegojs/tego-standard/pull/1801)) (@bai.zixv)
- add script to modify database schema due to client code upgrade ([#1793](https://github.com/tegojs/tego-standard/pull/1793)) (@Toby)
- **workflow**: execution time column ([#1797](https://github.com/tegojs/tego-standard/pull/1797)) (@fanyukun)
- **event-source**: init support resource define ([#1798](https://github.com/tegojs/tego-standard/pull/1798)) (@sealday)
- **approval**: support search id ([#1795](https://github.com/tegojs/tego-standard/pull/1795)) (@bai.zixv)
- init turbo build support ([#1791](https://github.com/tegojs/tego-standard/pull/1791)) (@sealday)
- new spin ([#1786](https://github.com/tegojs/tego-standard/pull/1786)) (@sealday)
- schema initializer support waitlist ([#1785](https://github.com/tegojs/tego-standard/pull/1785)) (@sealday)
- **approval**: change Table -> TableV2 in approval plugin ([#1781](https://github.com/tegojs/tego-standard/pull/1781)) (@bai.zixv)
- action decorator support acl options ([#1774](https://github.com/tegojs/tego-standard/pull/1774)) (@sealday)
- workflows sort by init time not by current create time ([#1768](https://github.com/tegojs/tego-standard/pull/1768)) (@Toby)
- init pdf module and refactor workflow module ([#1765](https://github.com/tegojs/tego-standard/pull/1765)) (@sealday)
- **client**: add scroll area to page ([#1755](https://github.com/tegojs/tego-standard/pull/1755)) (@bai.zixv)
- **approval**: fuzzy approval search ([#1760](https://github.com/tegojs/tego-standard/pull/1760)) (@bai.zixv)
- adjust pop-up label storage ([#1753](https://github.com/tegojs/tego-standard/pull/1753)) (@wjh)
- **auth**: user binding mechanism and wechat verification now support user binding ([#1740](https://github.com/tegojs/tego-standard/pull/1740)) (@Toby)
- **scripts**: detect empty project folders ([#1744](https://github.com/tegojs/tego-standard/pull/1744)) (@fanyukun)
- experimental support for mako ([#1747](https://github.com/tegojs/tego-standard/pull/1747)) (@sealday)
- **approval**: search in summary ([#1741](https://github.com/tegojs/tego-standard/pull/1741)) (@bai.zixv)
- dynamic schema props decorator ([#1742](https://github.com/tegojs/tego-standard/pull/1742)) (@sealday)
- add scripts to check whether the package names are correct and provide automatic corrections for incorrect package names. ([#1734](https://github.com/tegojs/tego-standard/pull/1734)) (@fanyukun)
- 结算单计算触发工作流 ([#1733](https://github.com/tegojs/tego-standard/pull/1733)) (@wjh)
- **scripts**: add check names scripts ([#1732](https://github.com/tegojs/tego-standard/pull/1732)) (@sealday)
- workflow zoom state and splitter size state can saved now ([#1725](https://github.com/tegojs/tego-standard/pull/1725)) (@sealday)
- 添加工作流分支状态&合同状态更新脚本 ([#1721](https://github.com/tegojs/tego-standard/pull/1721)) (@wjh)
- workflow add moveUp and moveDown ([#1724](https://github.com/tegojs/tego-standard/pull/1724)) (@sealday)
- **workflow**: add refresh and filter to workflow table ([#1716](https://github.com/tegojs/tego-standard/pull/1716)) (@bai.zixv)
- **tb**: support sorting of context menu items ([#1714](https://github.com/tegojs/tego-standard/pull/1714)) (@bai.zixv)
- add demo app ([#1712](https://github.com/tegojs/tego-standard/pull/1712)) (@sealday)
- fix package json ([#1711](https://github.com/tegojs/tego-standard/pull/1711)) (@bai.zixv)
- add clean command to remove all files ([#1710](https://github.com/tegojs/tego-standard/pull/1710)) (@sealday)
- 系统设置访问保持公开 ([#1706](https://github.com/tegojs/tego-standard/pull/1706)) (@bai.zixv)
- support interaction and calling between different workflows ([#1692](https://github.com/tegojs/tego-standard/pull/1692)) (@Toby)
- 更改翻译文案 ([#1704](https://github.com/tegojs/tego-standard/pull/1704)) (@bai.zixv)
- **departments**: support show all members ([#1686](https://github.com/tegojs/tego-standard/pull/1686)) (@Toby)
- experimental support for react-based PDF rendering ([#1703](https://github.com/tegojs/tego-standard/pull/1703)) (@sealday)
- move use repository.update ([#1689](https://github.com/tegojs/tego-standard/pull/1689)) (@Toby)
- add demo game block runesweeper ([#1684](https://github.com/tegojs/tego-standard/pull/1684)) (@sealday)
- svg类型图片预览 ([#1669](https://github.com/tegojs/tego-standard/pull/1669)) (@wjh)
- add multi app manager block ([#1668](https://github.com/tegojs/tego-standard/pull/1668)) (@Toby)
- new menu ui ([#1664](https://github.com/tegojs/tego-standard/pull/1664)) (@sealday)
- **approval**: add translate text ([#1658](https://github.com/tegojs/tego-standard/pull/1658)) (@bai.zixv)
- 结算单新增期限免租&最短租期计算方式 ([#1651](https://github.com/tegojs/tego-standard/pull/1651)) (@wjh)
- scroll-assistant now support wheel event ([#1654](https://github.com/tegojs/tego-standard/pull/1654)) (@sealday)
- **tb**: update icon ([#1648](https://github.com/tegojs/tego-standard/pull/1648)) (@bai.zixv)
- **tb**: 图标更替 ([#1633](https://github.com/tegojs/tego-standard/pull/1633)) ([#1641](https://github.com/tegojs/tego-standard/pull/1641)) (@sealday)
- init support remix ([#1628](https://github.com/tegojs/tego-standard/pull/1628)) (@sealday)
- 删掉hera多余的sql,支持在sql语句第一行-- dialect: postgres 这样提明支持的dialect ([#1627](https://github.com/tegojs/tego-standard/pull/1627)) (@Toby)
- **red-node**: init support red-node adapters ([#1621](https://github.com/tegojs/tego-standard/pull/1621)) (@sealday)
- 附件添加图像的默认预览方式 ([#1614](https://github.com/tegojs/tego-standard/pull/1614)) (@bai.zixv)
- improve tachybase presets ([#1609](https://github.com/tegojs/tego-standard/pull/1609)) (@sealday)
- **client**: add welcome card ([#1606](https://github.com/tegojs/tego-standard/pull/1606)) (@sealday)
- **workflow**: support api hooks ([#1591](https://github.com/tegojs/tego-standard/pull/1591)) (@sealday)
- **数据表**: REST API ([#1567](https://github.com/tegojs/tego-standard/pull/1567)) (@bai.zixv)
- web notification ([#1573](https://github.com/tegojs/tego-standard/pull/1573)) (@sealday)
- **workflow**: 移除工作流操作类型的触发事件 ([#1561](https://github.com/tegojs/tego-standard/pull/1561)) (@bai.zixv)
- 数据表导入导出 ([#1550](https://github.com/tegojs/tego-standard/pull/1550)) (@sealday)
- 订阅渠道管理 ([#1546](https://github.com/tegojs/tego-standard/pull/1546)) (@sealday)
- 用户设置页面 ([#1540](https://github.com/tegojs/tego-standard/pull/1540)) (@sealday)
- 通知与个人页面改版（WIP） ([#1455](https://github.com/tegojs/tego-standard/pull/1455)) (@sealday)
- 右键代码移到core，添加右键区块全屏操作 ([#1524](https://github.com/tegojs/tego-standard/pull/1524)) (@wjh)
- **dianziqian**: url保存附件支持json格式 ([#1517](https://github.com/tegojs/tego-standard/pull/1517)) (@wanggang)
- **plugin-wechat-auth**: wechat qr login ([#1516](https://github.com/tegojs/tego-standard/pull/1516)) (@TomyJan)
- **workflow**: dispatcher support pass user info ([#1512](https://github.com/tegojs/tego-standard/pull/1512)) (@sealday)
- **multi-app-manager**: custom sub app start options ( #1498 ) ([#1506](https://github.com/tegojs/tego-standard/pull/1506)) (@TomyJan)
- 新增自定义跳转页面 ([#1499](https://github.com/tegojs/tego-standard/pull/1499)) (@bai.zixv)
- **multi-app-manager**: manual operate sub app ([#1488](https://github.com/tegojs/tego-standard/pull/1488)) (@TomyJan)
- **approval**: v2 ([#1476](https://github.com/tegojs/tego-standard/pull/1476)) (@bai.zixv)
- **multi-app-manager**: create sub app via tmpl ([#1469](https://github.com/tegojs/tego-standard/pull/1469)) (@TomyJan)
- 新增自定义筛选组件，调整筛选字段内容 ([#1468](https://github.com/tegojs/tego-standard/pull/1468)) (@wjh)
- **telemetry**: add `Sentry` as frontend telemetry ([#1458](https://github.com/tegojs/tego-standard/pull/1458)) (@TomyJan)
- 多对多关系可以添加关联 ([#1333](https://github.com/tegojs/tego-standard/pull/1333)) (@wjh)
- view form values ([#1443](https://github.com/tegojs/tego-standard/pull/1443)) (@sealday)
- oneClick to publish WeChat public account tweets ([#1417](https://github.com/tegojs/tego-standard/pull/1417)) (@luliangqiang)
- **client**: upgrade antd to 5.19.4, designable mode can edit component schema directly now. close #1432 ([#1434](https://github.com/tegojs/tego-standard/pull/1434)) (@sealday)
- **workflow**: support attachment field assign in workflow create/update nodes. ([#1419](https://github.com/tegojs/tego-standard/pull/1419)) (@sealday)
- blockchain ([#1408](https://github.com/tegojs/tego-standard/pull/1408)) (@hua)
- **omni-trigger**: resourceName from params ([#1416](https://github.com/tegojs/tego-standard/pull/1416)) (@bai.zixv)
- prepare demo stage 1 ([#1412](https://github.com/tegojs/tego-standard/pull/1412)) (@sealday)
- **telemetry**: export traces data in otlp format & matrics data to prometheus ([#1400](https://github.com/tegojs/tego-standard/pull/1400)) (@TomyJan)
- 微信公众号登录插件-未重定向 ([#1405](https://github.com/tegojs/tego-standard/pull/1405)) (@luliangqiang)
- **data-mapping**: add new useage ([#1403](https://github.com/tegojs/tego-standard/pull/1403)) (@bai.zixv)
- **approval**: hidden updateForm when approvaled ([#1397](https://github.com/tegojs/tego-standard/pull/1397)) (@bai.zixv)
- replace code-mirror with monaco ([#1395](https://github.com/tegojs/tego-standard/pull/1395)) (@sealday)
- 将word转pdf ([#1380](https://github.com/tegojs/tego-standard/pull/1380)) (@yoona)
- telemetry init ([#1378](https://github.com/tegojs/tego-standard/pull/1378)) (@TomyJan)
- 添加下载文档和显示数据按钮 ([#1370](https://github.com/tegojs/tego-standard/pull/1370)) (@wjh)
- 企业微信扫码登录插件 ([#1364](https://github.com/tegojs/tego-standard/pull/1364)) (@huahua)
- plugin-bullmq-adapter ([#1365](https://github.com/tegojs/tego-standard/pull/1365)) (@sealday)
- share ([#1358](https://github.com/tegojs/tego-standard/pull/1358)) (@TomyJan)
- approval, carbon copy unique record ([#1349](https://github.com/tegojs/tego-standard/pull/1349)) (@bai.zixv)
- official-account ([#1348](https://github.com/tegojs/tego-standard/pull/1348)) (@ALIANG)
- workflow, end node, passthrough result ([#1344](https://github.com/tegojs/tego-standard/pull/1344)) (@bai.zixv)
- dingtalk ([#1340](https://github.com/tegojs/tego-standard/pull/1340)) (@sealday)
- printTemplate ([#1338](https://github.com/tegojs/tego-standard/pull/1338)) (@yoona)
- approval, carbon copy ([#1330](https://github.com/tegojs/tego-standard/pull/1330)) (@bai.zixv)
- access token ([#1320](https://github.com/tegojs/tego-standard/pull/1320)) (@sealday)
- approval, todo initiator ([#1317](https://github.com/tegojs/tego-standard/pull/1317)) (@bai.zixv)
- pc端发起审批模块 ([#1316](https://github.com/tegojs/tego-standard/pull/1316)) (@wjh)
- data mapping, finish ([#1312](https://github.com/tegojs/tego-standard/pull/1312)) (@bai.zixv)
- codemirror, add theme ([#1311](https://github.com/tegojs/tego-standard/pull/1311)) (@bai.zixv)
- workflow trigger support blacklist ([#1309](https://github.com/tegojs/tego-standard/pull/1309)) (@sealday)
- jsparse, add crypto lib & feat: jsparse, jscode tooptip & fix: workflow, json parse, CodeMirror ([#1306](https://github.com/tegojs/tego-standard/pull/1306)) (@bai.zixv)
- jsparse, jscode tooptip ([#1303](https://github.com/tegojs/tego-standard/pull/1303)) (@bai.zixv)
- all, change jsonParse instruction config ([#1301](https://github.com/tegojs/tego-standard/pull/1301)) (@bai.zixv)
- refactor resubmit ([#1290](https://github.com/tegojs/tego-standard/pull/1290)) (@sealday)
- approval, fix draft ([#1281](https://github.com/tegojs/tego-standard/pull/1281)) (@bai.zixv)
- 添加手机端审批重新申请功能 ([#1273](https://github.com/tegojs/tego-standard/pull/1273)) (@wjh)
- approval,prevent create approvalRecords ([#1272](https://github.com/tegojs/tego-standard/pull/1272)) (@bai.zixv)
- approval, resubmit approval ([#1270](https://github.com/tegojs/tego-standard/pull/1270)) (@bai.zixv)
- refactor mobile components and add extend collection in form ([#1259](https://github.com/tegojs/tego-standard/pull/1259)) (@sealday)
- searchJump and calculator (@sealday)
- support stock_v2 ([#1249](https://github.com/tegojs/tego-standard/pull/1249)) (@sealday)
- 审批编辑 (@bai.zixv)
- excel ([#1004](https://github.com/tegojs/tego-standard/pull/1004)) (@sealday)
- 添加mobile的级联组件 ([#1221](https://github.com/tegojs/tego-standard/pull/1221)) (@wjh)
- init support notice area ([#1216](https://github.com/tegojs/tego-standard/pull/1216)) (@sealday)
- support workflow load dump ([#1199](https://github.com/tegojs/tego-standard/pull/1199)) (@sealday)
- add code-mirror ([#1195](https://github.com/tegojs/tego-standard/pull/1195)) (@sealday)
- webhook can trigger workflows ([#1193](https://github.com/tegojs/tego-standard/pull/1193)) (@sealday)
- support features ([#1189](https://github.com/tegojs/tego-standard/pull/1189)) (@sealday)
- now workflow can response ([#1186](https://github.com/tegojs/tego-standard/pull/1186)) (@sealday)
- use visible before use component props ([#1182](https://github.com/tegojs/tego-standard/pull/1182)) (@sealday)
- quick add support sort ([#1175](https://github.com/tegojs/tego-standard/pull/1175)) (@sealday)
- support webhook-manager ([#1152](https://github.com/tegojs/tego-standard/pull/1152)) (@sealday)
- 子表单添加快速创建的折叠功能 ([#1143](https://github.com/tegojs/tego-standard/pull/1143)) (@wjh)
- loop notify ([#1138](https://github.com/tegojs/tego-standard/pull/1138)) (@sealday)
- notice hard coded ([#1136](https://github.com/tegojs/tego-standard/pull/1136)) (@sealday)
- notice for backup ([#1134](https://github.com/tegojs/tego-standard/pull/1134)) (@sealday)
- notice manager ([#1131](https://github.com/tegojs/tego-standard/pull/1131)) (@sealday)
- 子表格新增快速添加功能 ([#1122](https://github.com/tegojs/tego-standard/pull/1122)) (@wjh)
- plugin-workfow, api regular ([#1103](https://github.com/tegojs/tego-standard/pull/1103)) (@bai.zixv)
- new action.area ([#1113](https://github.com/tegojs/tego-standard/pull/1113)) (@sealday)
- support multiple entries ([#1104](https://github.com/tegojs/tego-standard/pull/1104)) (@sealday)
- 添加移动端选择框组件 ([#1093](https://github.com/tegojs/tego-standard/pull/1093)) (@wangjiahui)
- plugin-workflow-json-parse ([#1091](https://github.com/tegojs/tego-standard/pull/1091)) (@bai.zixv)
- subtable actions ([#1082](https://github.com/tegojs/tego-standard/pull/1082)) (@sealday)
- plugin-core, code field eval ([#1079](https://github.com/tegojs/tego-standard/pull/1079)) (@bai.zixv)
- support build erros dump ([#1069](https://github.com/tegojs/tego-standard/pull/1069)) (@sealday)
- plugin-approvals, notice config select ([#1048](https://github.com/tegojs/tego-standard/pull/1048)) (@bai.zixv)
- approval summary and refactor antd-style ([#1036](https://github.com/tegojs/tego-standard/pull/1036)) (@bai.zixv)
- optimize checkbox in filter form ([#1024](https://github.com/tegojs/tego-standard/pull/1024)) (@sealday)
- support comments ([#1022](https://github.com/tegojs/tego-standard/pull/1022)) (@sealday)
- multi app and plugins ([#1020](https://github.com/tegojs/tego-standard/pull/1020)) (@sealday)
- support mysql as data source ([#1018](https://github.com/tegojs/tego-standard/pull/1018)) (@sealday)
- infinite scroll and linkable card items (@bai.zixv)
- support layout direction (@bai.zixv)
- init support mobile approvals ([#1002](https://github.com/tegojs/tego-standard/pull/1002)) (@bai.zixv)
- 支持新样式配置 ([#1000](https://github.com/tegojs/tego-standard/pull/1000)) (@sealday)
- support pdf zoom in mobile ([#990](https://github.com/tegojs/tego-standard/pull/990)) (@sealday)
- support open mode sheet ([#989](https://github.com/tegojs/tego-standard/pull/989)) (@sealday)
- tachybase 图标，公式支持自动编码 ([#987](https://github.com/tegojs/tego-standard/pull/987)) (@sealday)
- fix 模版报错报错 ([#971](https://github.com/tegojs/tego-standard/pull/971)) (@hello@lv)
- support mobile field related ([#941](https://github.com/tegojs/tego-standard/pull/941)) (@bai.zixv)
- support view contracts ([#947](https://github.com/tegojs/tego-standard/pull/947)) (@sealday)
- contract date range ([#939](https://github.com/tegojs/tego-standard/pull/939)) (@sealday)
- 二期调整 ([#926](https://github.com/tegojs/tego-standard/pull/926)) (@hello@lv)
- 仓库二期 ([#719](https://github.com/tegojs/tego-standard/pull/719)) (@sealday)
- support edit associated form ([#920](https://github.com/tegojs/tego-standard/pull/920)) (@sealday)
- support default setting items ([#918](https://github.com/tegojs/tego-standard/pull/918)) (@sealday)
- support other collection in popup ([#916](https://github.com/tegojs/tego-standard/pull/916)) close #838 (@sealday)
- support tab dump and load ([#915](https://github.com/tegojs/tego-standard/pull/915)) (@sealday)
- plugin-rental, support calc tax ,filter by category ([#909](https://github.com/tegojs/tego-standard/pull/909)) (@bai.zixv)
- 合并 @hera/plugin-mobile 到 @tachybase/plugin-mobile-client close #906 ([#912](https://github.com/tegojs/tego-standard/pull/912)) (@wjh)
- 三聪头相关移动端支持逻辑 ([#798](https://github.com/tegojs/tego-standard/pull/798)) (@bai.zixv)
- support workflow bulk ([#858](https://github.com/tegojs/tego-standard/pull/858)) (@sealday)
- support vditor ([#894](https://github.com/tegojs/tego-standard/pull/894)) (@sealday)
- plugin-core, extends calcResult support jsx dayjs ([#882](https://github.com/tegojs/tego-standard/pull/882)) (@bai.zixv)
- support-business-fields ([#879](https://github.com/tegojs/tego-standard/pull/879)) (@sealday)
- support business fields ([#877](https://github.com/tegojs/tego-standard/pull/877)) (@sealday)
- support context menu and draggable button ([#844](https://github.com/tegojs/tego-standard/pull/844)) (@sealday)
- 订单修改结算单状态未改变 close #847 ([#848](https://github.com/tegojs/tego-standard/pull/848)) (@hello@lv)
- support sort m2m & o2m fields ([#768](https://github.com/tegojs/tego-standard/pull/768)) (@sealday)
- support date range field ([#828](https://github.com/tegojs/tego-standard/pull/828)) (@sealday)
- improve approval ([#820](https://github.com/tegojs/tego-standard/pull/820)) (@sealday)
- record pdf cache ([#823](https://github.com/tegojs/tego-standard/pull/823)) (@sealday)
- 工作流审批组件完善 ([#673](https://github.com/tegojs/tego-standard/pull/673)) (@bai.zixv)
- 支持快速更新插件版本 ([#797](https://github.com/tegojs/tego-standard/pull/797)) (@bai.zixv)
- init support departments ([#788](https://github.com/tegojs/tego-standard/pull/788)) (@sealday)
- support embed page ([#786](https://github.com/tegojs/tego-standard/pull/786)) (@sealday)
- init external data source support ([#785](https://github.com/tegojs/tego-standard/pull/785)) (@sealday)
- support cached (@sealday)
- support release by ci (@sealday)
- support-actions ([#758](https://github.com/tegojs/tego-standard/pull/758)) (@sealday)
- 新增mobile审批组件样式模版 close #742 ([#763](https://github.com/tegojs/tego-standard/pull/763)) (@wjh)
- 合同费用校验（无产品关联先跳过）clost #756 ([#757](https://github.com/tegojs/tego-standard/pull/757)) (@hello@lv)
- 图标搜索优化, 给选中的图标添加背景色,方便识别 ([#754](https://github.com/tegojs/tego-standard/pull/754)) (@bai.zixv)
- 将表单的布局模式,按钮设置的默认位置, 放置在右上角 (@bai.zixv)
- 支持设置显示附件数量 ([#753](https://github.com/tegojs/tego-standard/pull/753)) (@bai.zixv)
- to_char 图表时间字段时区问题 close #747 ([#750](https://github.com/tegojs/tego-standard/pull/750)) (@hello@lv)
- 图标支持快捷搜索, 悬浮提示 ([#743](https://github.com/tegojs/tego-standard/pull/743)) (@bai.zixv)
- 更改表格列宽默认值为20 ([#741](https://github.com/tegojs/tego-standard/pull/741)) (@bai.zixv)
- 更改npm包管理器默认地址, 以及 更改dump-load的file选项为必选 ([#740](https://github.com/tegojs/tego-standard/pull/740)) (@bai.zixv)
- 运输单分组计算接口 feat #726 ([#728](https://github.com/tegojs/tego-standard/pull/728)) (@hello@lv)
- 结算单预览添加订单数量字段 ([#716](https://github.com/tegojs/tego-standard/pull/716)) (@wjh)
- 移动端筛选区块二期：支持更多类型 ([#702](https://github.com/tegojs/tego-standard/pull/702)) (@wjh)
- 新命令行工具 @tachybase/cli (@sealday)
- 运输单pdf付款方公司项目显示顺序调整 feat #694 ([#695](https://github.com/tegojs/tego-standard/pull/695)) (@hello@lv)
- 支持轮播图设置和跳转 (@sealday)
- 费用范围没有考虑直发单，先简单处理掉  feat #687 ([#688](https://github.com/tegojs/tego-standard/pull/688)) (@hello@lv)
- support .env.local.* (@sealday)
- 初步支持审批流程 (@sealday)
- 移动端支持筛选 (@sealday)
- 显示界面支持货币取反 ([#666](https://github.com/tegojs/tego-standard/pull/666)) (@bai.jingfeng)
- 合同方案租金表添加修改校验 (@lyx)
- 合同方案租金产品校验修改，长度相同进行校验 (@lyx)
- 更新提交数据,支持增量提交 (@bai.jingfeng)
- 更新属性结构appends情况 feat #620 (@lyx)
- 更新订单分组区块，重量/金额实现方式 feat #600 ([#604](https://github.com/tegojs/tego-standard/pull/604)) (@hello@lv)
- 支持级联范围过滤 (@hello@lv)
- optimize block add menu (@sealday)
- 系统设置-交互行为优化. 系统设置区块,配置操作,提交按钮,初始化时,支持设置提交成功后的回调 (@bai.jingfeng)
- @formily/* 统一成 @nocobase/schema，清理所有的 ts build 报错 ([#566](https://github.com/tegojs/tego-standard/pull/566)) (@sealday)
- 支持 docker 构建 (@sealday)
- 添加logger debug埋点输出 feat #459 (@lyx)

### 🐛 Fixed

- worker thread production start error ([#1909](https://github.com/tegojs/tego-standard/pull/1909)) (@Toby)
- i18n (@sealday)
- worker thread (@sealday)
- admin settings layout jump ([#1903](https://github.com/tegojs/tego-standard/pull/1903)) (@sealday)
- resource events being added repeatedly ([#1900](https://github.com/tegojs/tego-standard/pull/1900)) (@sealday)
- build warnings ([#1899](https://github.com/tegojs/tego-standard/pull/1899)) (@sealday)
- name error (@sealday)
- init app not load roles (@sealday)
- module not found (@sealday)
- **client**: system settings ([#1894](https://github.com/tegojs/tego-standard/pull/1894)) (@sealday)
- extern pg not show uppercase table ([#1893](https://github.com/tegojs/tego-standard/pull/1893)) (@Toby)
- **client**: navigate errors ([#1892](https://github.com/tegojs/tego-standard/pull/1892)) (@sealday)
- multi app create error, need default preset ([#1891](https://github.com/tegojs/tego-standard/pull/1891)) (@Toby)
- package-name error (@sealday)
- module export (@sealday)
- import errors ([#1887](https://github.com/tegojs/tego-standard/pull/1887)) (@sealday)
- migration of hera hook to workflow ([#1882](https://github.com/tegojs/tego-standard/pull/1882)) (@wjh)
- **server**: ignore some load error (@sealday)
- migration of hera hook to workflow ([#1875](https://github.com/tegojs/tego-standard/pull/1875)) (@wjh)
- revert to old tooltip version (@sealday)
- after start database instance not found (@sealday)
- container can not load controller when init (@sealday)
- dev using relative path for easier copying (@sealday)
- change link to tachybase (@sealday)
- web service not load when hera not load ([#1876](https://github.com/tegojs/tego-standard/pull/1876)) (@sealday)
- version check (@sealday)
- node in history ([#1872](https://github.com/tegojs/tego-standard/pull/1872)) (@bai.zixv)
- **cloud-component**: schema conflict issue between cloud components and event sources ([#1870](https://github.com/tegojs/tego-standard/pull/1870)) (@sealday)
- node in history ([#1868](https://github.com/tegojs/tego-standard/pull/1868)) (@bai.zixv)
- migration of hera hook to workflow ([#1862](https://github.com/tegojs/tego-standard/pull/1862)) (@wjh)
- **department**: department show all member error, can not remove department from role ([#1860](https://github.com/tegojs/tego-standard/pull/1860)) (@Toby)
- migration of hera front end components  to cloud component ([#1858](https://github.com/tegojs/tego-standard/pull/1858)) (@wjh)
- migration of hera custom component to cloud component ([#1853](https://github.com/tegojs/tego-standard/pull/1853)) (@wjh)
- **cloud-component**: load packages when dev ([#1854](https://github.com/tegojs/tego-standard/pull/1854)) (@sealday)
- **client**: recursive component only displays the innermost toolbar (@sealday)
- **cloud-component**: can not load memo function ([#1850](https://github.com/tegojs/tego-standard/pull/1850)) (@sealday)
- cloud component enable error ([#1847](https://github.com/tegojs/tego-standard/pull/1847)) (@Toby)
- kanban (@sealday)
- **cloud-component**: table effect immediately (@sealday)
- cloud component works in table (@sealday)
- designable work for new style toolbar ([#1846](https://github.com/tegojs/tego-standard/pull/1846)) (@sealday)
- **cloud-component**: auth errors ([#1841](https://github.com/tegojs/tego-standard/pull/1841)) (@sealday)
- **approval**: fuzzySearch params error ([#1840](https://github.com/tegojs/tego-standard/pull/1840)) (@bai.zixv)
- **client**: display repeat create success message ([#1831](https://github.com/tegojs/tego-standard/pull/1831)) (@fanyukun)
- add record is_end field ([#1833](https://github.com/tegojs/tego-standard/pull/1833)) (@wjh)
- **export**: pre count before find ([#1832](https://github.com/tegojs/tego-standard/pull/1832)) (@Toby)
- **collection-manager**: import table no longer import categories, and import failures do not refresh the page ([#1830](https://github.com/tegojs/tego-standard/pull/1830)) (@Toby)
- **acl**: message: ACL error, multi-app should grant the "list" permission to loggedIn ([#1826](https://github.com/tegojs/tego-standard/pull/1826)) (@Toby)
- template only get owner or admin set ([#1824](https://github.com/tegojs/tego-standard/pull/1824)) (@Toby)
- settlement statement does not trigger voucher automatic update ([#1820](https://github.com/tegojs/tego-standard/pull/1820)) (@wjh)
- acl [view,update,destroy] check include many include lead to cpu crash ([#1817](https://github.com/tegojs/tego-standard/pull/1817)) (@Toby)
- readonly bug ([#1812](https://github.com/tegojs/tego-standard/pull/1812)) (@bai.zixv)
- pdf logger ([#1811](https://github.com/tegojs/tego-standard/pull/1811)) (@sealday)
- revert mako default ([#1805](https://github.com/tegojs/tego-standard/pull/1805)) (@sealday)
- unique key approvalProvider ([#1800](https://github.com/tegojs/tego-standard/pull/1800)) (@bai.zixv)
- adjust SVG component ([#1799](https://github.com/tegojs/tego-standard/pull/1799)) (@wjh)
- linkage rule lead to many times request ([#1792](https://github.com/tegojs/tego-standard/pull/1792)) (@bai.zixv)
- **approval**: approval ApprovalBlock.Launch.Application ([#1788](https://github.com/tegojs/tego-standard/pull/1788)) (@bai.zixv)
- moudle pdf build ([#1787](https://github.com/tegojs/tego-standard/pull/1787)) (@sealday)
- workflow approval mobile plugin removal ([#1782](https://github.com/tegojs/tego-standard/pull/1782)) (@sealday)
- **approval**: translate namespace ([#1780](https://github.com/tegojs/tego-standard/pull/1780)) (@bai.zixv)
- workflow view history nodes & configure and add category keys ([#1776](https://github.com/tegojs/tego-standard/pull/1776)) (@wjh)
- module i18n ([#1770](https://github.com/tegojs/tego-standard/pull/1770)) (@sealday)
- **client**: scroll ([#1771](https://github.com/tegojs/tego-standard/pull/1771)) (@bai.zixv)
- module pdf and event source should be enabled default ([#1767](https://github.com/tegojs/tego-standard/pull/1767)) (@sealday)
- same auth public can not be overwrite by loggedIn ([#1764](https://github.com/tegojs/tego-standard/pull/1764)) (@Toby)
- calculation of settlement statement fees & PDF view ([#1763](https://github.com/tegojs/tego-standard/pull/1763)) (@wjh)
- **approval**: useSubmit form status fixed ([#1762](https://github.com/tegojs/tego-standard/pull/1762)) (@bai.zixv)
- controller init fails ([#1758](https://github.com/tegojs/tego-standard/pull/1758)) (@sealday)
- getUserInfo to show bind nickname, limit sign in timeout (@Toby)
- proxy port failed (@sealday)
- date adaptation of mobile tab-search component ([#1746](https://github.com/tegojs/tego-standard/pull/1746)) (@wjh)
- pdf-viewer scrollable in pc and refactor mobile-provider ([#1739](https://github.com/tegojs/tego-standard/pull/1739)) (@sealday)
- type errors when useTranslation ([#1736](https://github.com/tegojs/tego-standard/pull/1736)) (@sealday)
- umi module find fails ([#1731](https://github.com/tegojs/tego-standard/pull/1731)) (@sealday)
- ignore rental upgrade errors ([#1730](https://github.com/tegojs/tego-standard/pull/1730)) (@sealday)
- 修改结算单关联赔偿支持订单金额 ([#1727](https://github.com/tegojs/tego-standard/pull/1727)) (@wjh)
- dont change workflow node key when move up ([#1728](https://github.com/tegojs/tego-standard/pull/1728)) (@sealday)
- workflow save state by type ([#1726](https://github.com/tegojs/tego-standard/pull/1726)) (@sealday)
- cli and docker file path error ([#1722](https://github.com/tegojs/tego-standard/pull/1722)) (@Toby)
- **approval**: fix approval show amount error (@bai.zixv)
- viewport, meta scalesize, 1.0 ([#1713](https://github.com/tegojs/tego-standard/pull/1713)) (@bai.zixv)
- **approval**: forbidden trigger workflow when some status changed ([#1709](https://github.com/tegojs/tego-standard/pull/1709)) (@bai.zixv)
- cloud component can now run in both dev and prod environment ([#1702](https://github.com/tegojs/tego-standard/pull/1702)) (@sealday)
- **page-tab**: stopPropagation on close tag ([#1700](https://github.com/tegojs/tego-standard/pull/1700)) (@bai.zixv)
- quickstart ([#1696](https://github.com/tegojs/tego-standard/pull/1696)) (@sealday)
- 完善欢迎卡片 ([#1695](https://github.com/tegojs/tego-standard/pull/1695)) (@bai.zixv)
- 修复结算单最短租期显示 ([#1691](https://github.com/tegojs/tego-standard/pull/1691)) (@wjh)
- 工作流内嵌弹窗样式问题 ([#1687](https://github.com/tegojs/tego-standard/pull/1687)) (@wjh)
- tab panel reset after switch to other tab ([#1690](https://github.com/tegojs/tego-standard/pull/1690)) (@sealday)
- docker-entrypoint ([#1685](https://github.com/tegojs/tego-standard/pull/1685)) (@sealday)
- sentry path error ([#1682](https://github.com/tegojs/tego-standard/pull/1682)) (@sealday)
- pdf dist files ([#1679](https://github.com/tegojs/tego-standard/pull/1679)) (@sealday)
- **approval**: approval todos show process component bug ([#1674](https://github.com/tegojs/tego-standard/pull/1674)) (@bai.zixv)
- graph migration ([#1675](https://github.com/tegojs/tego-standard/pull/1675)) (@sealday)
- action sheet translations ([#1673](https://github.com/tegojs/tego-standard/pull/1673)) (@sealday)
- limit excel export & date format to string with client timezone ([#1661](https://github.com/tegojs/tego-standard/pull/1661)) (@Toby)
- 修改下拉框设置默认值不生效 ([#1662](https://github.com/tegojs/tego-standard/pull/1662)) (@wjh)
- **tb**: 修复平板设备过于缩小问题 ([#1655](https://github.com/tegojs/tego-standard/pull/1655)) (@bai.zixv)
- 修复工作流审批节点保存报错 ([#1653](https://github.com/tegojs/tego-standard/pull/1653)) (@wjh)
- **client**: submenu display empty label ([#1652](https://github.com/tegojs/tego-standard/pull/1652)) (@sealday)
- add duplicated plugin ([#1642](https://github.com/tegojs/tego-standard/pull/1642)) (@sealday)
- 修改添加车辆字符验证 ([#1631](https://github.com/tegojs/tego-standard/pull/1631)) (@wjh)
- **remix**: build error ([#1629](https://github.com/tegojs/tego-standard/pull/1629)) (@sealday)
- plugin-data-visualization lack timestamp format function #1616 ([#1625](https://github.com/tegojs/tego-standard/pull/1625)) (@Toby)
- **red-node**: red node build failed ([#1622](https://github.com/tegojs/tego-standard/pull/1622)) (@sealday)
- **core**: 修复类型错误 ([#1620](https://github.com/tegojs/tego-standard/pull/1620)) (@bai.zixv)
- **tb**: 附件的宽度适配调整 ([#1619](https://github.com/tegojs/tego-standard/pull/1619)) (@bai.zixv)
- **tb**: 替换开源pdf附件组件 & feat(tb):附件支持execl预览功能 ([#1612](https://github.com/tegojs/tego-standard/pull/1612)) (@bai.zixv)
- **审批**: 审批修复, 摘要宽度, 状态更正 #1597 & fix(审批): 审批修复, 必填项没填禁止发起 ([#1613](https://github.com/tegojs/tego-standard/pull/1613)) (@bai.zixv)
- app upgrade should not overwrite the activation status of plugins ([#1610](https://github.com/tegojs/tego-standard/pull/1610)) (@sealday)
- **auth**: 修复重置数据问题 ([#1598](https://github.com/tegojs/tego-standard/pull/1598)) (@bai.zixv)
- 审批摘要, 文案过长时候要换行(更换一行显示) ([#1590](https://github.com/tegojs/tego-standard/pull/1590)) (@wjh)
- **notification**: not support in mobile browser ([#1588](https://github.com/tegojs/tego-standard/pull/1588)) (@sealday)
- **审批**: 审批摘要, 文案过长时候要换行 ([#1587](https://github.com/tegojs/tego-standard/pull/1587)) (@wjh)
- 修复对账单无法重新结算 ([#1586](https://github.com/tegojs/tego-standard/pull/1586)) (@wjh)
- **数据表**: 树数据表-级联修复,修复级联选择编辑无显示 ([#1583](https://github.com/tegojs/tego-standard/pull/1583)) (@wjh)
- **workflow**: 数据表触发时机为更新数据的黑白名单机制修改 ([#1585](https://github.com/tegojs/tego-standard/pull/1585)) (@Toby)
- 审批创建日期复制后重新提交还是之前的日期&审批移动端始终将创建日期排在第一个(取审批的创建日期) ([#1581](https://github.com/tegojs/tego-standard/pull/1581)) (@wjh)
- 修复项目库存计算无法完结 ([#1582](https://github.com/tegojs/tego-standard/pull/1582)) (@wjh)
- 移动端审批发起添加默认筛选条件 ([#1576](https://github.com/tegojs/tego-standard/pull/1576)) (@wjh)
- 完善右键全屏 ([#1572](https://github.com/tegojs/tego-standard/pull/1572)) (@wjh)
- **移动端-框架**: 附件删除(删除不掉) ([#1574](https://github.com/tegojs/tego-standard/pull/1574)) (@wjh)
- 修复有互相引用的字段导入问题 ([#1568](https://github.com/tegojs/tego-standard/pull/1568)) (@Toby)
- **acl**: sync role strategy after create ([#1565](https://github.com/tegojs/tego-standard/pull/1565)) (@sealday)
- 优化附件显示 ([#1545](https://github.com/tegojs/tego-standard/pull/1545)) (@wjh)
- **workflow**: 移除废弃文案 ([#1562](https://github.com/tegojs/tego-standard/pull/1562)) (@bai.zixv)
- **workflow**: 添加提交按钮允许绑定通用工作流并触发 ([#1560](https://github.com/tegojs/tego-standard/pull/1560)) (@bai.zixv)
- theme error, close #1557 ([#1558](https://github.com/tegojs/tego-standard/pull/1558)) (@sealday)
- **departments**: 切换部门,自动刷新获取当前用户列表 ([#1549](https://github.com/tegojs/tego-standard/pull/1549)) (@bai.zixv)
- **approval**: 容错处理,审批权限设置错误后,重新设置权限时触发的报错 ([#1536](https://github.com/tegojs/tego-standard/pull/1536)) (@bai.zixv)
- **approval**: 审批-发起, 去除硬编码 & 给审批-发起,添加默认的筛选条件 ([#1544](https://github.com/tegojs/tego-standard/pull/1544)) (@bai.zixv)
- 主题修改导航间距不生效 ([#1548](https://github.com/tegojs/tego-standard/pull/1548)) (@wjh)
- 完善个人设置界面 ([#1542](https://github.com/tegojs/tego-standard/pull/1542)) (@wjh)
- 筛选表单关联字段添加运算符 ([#1537](https://github.com/tegojs/tego-standard/pull/1537)) (@wjh)
- 退出全屏按钮适配导航 ([#1541](https://github.com/tegojs/tego-standard/pull/1541)) (@wjh)
- run in linux ([#1538](https://github.com/tegojs/tego-standard/pull/1538)) (@TomyJan)
- windows环境无法运行 ([#1535](https://github.com/tegojs/tego-standard/pull/1535)) (@Toby)
- **department**: 审批三期 ([#1507](https://github.com/tegojs/tego-standard/pull/1507)) (@bai.zixv)
- **dianziqian**: 处理url ([#1531](https://github.com/tegojs/tego-standard/pull/1531)) (@wanggang)
- **dianziqian**: 外部请求不带token ([#1529](https://github.com/tegojs/tego-standard/pull/1529)) (@wanggang)
- **plugin-dingtalk, plugin-wechat-auth, plugin-work-wechat**: oauth redirect url ([#1526](https://github.com/tegojs/tego-standard/pull/1526)) (@TomyJan)
- **multi-app-manager**: repeated judgment ([#1522](https://github.com/tegojs/tego-standard/pull/1522)) (@TomyJan)
- 合同添加甲乙字段并同步对账单 ([#1505](https://github.com/tegojs/tego-standard/pull/1505)) (@wjh)
- 修复图表的添加到检查列表无效 ([#1513](https://github.com/tegojs/tego-standard/pull/1513)) (@wjh)
- 关联表格添加无法使用引用模版 ([#1510](https://github.com/tegojs/tego-standard/pull/1510)) (@wjh)
- 修复替身合同结算实际重量不对 ([#1509](https://github.com/tegojs/tego-standard/pull/1509)) (@wjh)
- 备案号添加跳转链接 ([#1508](https://github.com/tegojs/tego-standard/pull/1508)) (@wjh)
- 审批重新提交&自定义筛选翻译 ([#1502](https://github.com/tegojs/tego-standard/pull/1502)) (@wjh)
- 多应用预览跳转路径不对 ([#1501](https://github.com/tegojs/tego-standard/pull/1501)) (@wjh)
- **migration**: fix path ([#1496](https://github.com/tegojs/tego-standard/pull/1496)) (@bai.zixv)
- 更新首页内容 ([#1495](https://github.com/tegojs/tego-standard/pull/1495)) (@wjh)
- 修改记录单关联项目没有符合预期 ([#1490](https://github.com/tegojs/tego-standard/pull/1490)) (@wjh)
- **app-supervisor**: wrong logic in app init ([#1489](https://github.com/tegojs/tego-standard/pull/1489)) (@TomyJan)
- 修复结算单无关联费用适应替身合同 ([#1487](https://github.com/tegojs/tego-standard/pull/1487)) (@wjh)
- 修复替身合同计算有问题 ([#1484](https://github.com/tegojs/tego-standard/pull/1484)) (@wjh)
- **grid**: col drag ([#1478](https://github.com/tegojs/tego-standard/pull/1478)) (@bai.zixv)
- 修复表格复制和直发单修改没有分组项 ([#1479](https://github.com/tegojs/tego-standard/pull/1479)) (@wjh)
- 修复结算单查看没有考虑替身合同问题 ([#1475](https://github.com/tegojs/tego-standard/pull/1475)) (@wjh)
- add checkout phase ([#1464](https://github.com/tegojs/tego-standard/pull/1464)) (@sealday)
- 修复直发单生成租赁单时维修赔偿数据没有更新 ([#1459](https://github.com/tegojs/tego-standard/pull/1459)) (@wjh)
- hera/core组件迁移到core ([#1453](https://github.com/tegojs/tego-standard/pull/1453)) (@wjh)
- **telemetry**: add log transport to avoid warn ([#1451](https://github.com/tegojs/tego-standard/pull/1451)) (@TomyJan)
- **telemetry**: only shutdown telemetry in `stop` ([#1454](https://github.com/tegojs/tego-standard/pull/1454)) (@TomyJan)
- 将自定义筛选字段移到core/client ([#1438](https://github.com/tegojs/tego-standard/pull/1438)) (@wjh)
- logger should log in file default ([#1429](https://github.com/tegojs/tego-standard/pull/1429)) (@sealday)
- 修改导航栏顶部菜单显示样式 ([#1425](https://github.com/tegojs/tego-standard/pull/1425)) (@wjh)
- **approval**: add designer for approval trigger && fix(approval-mobile)-change carboncopy listcenter ([#1420](https://github.com/tegojs/tego-standard/pull/1420)) (@bai.zixv)
- captchers ([#1424](https://github.com/tegojs/tego-standard/pull/1424)) (@sealday)
- original url containe empty strings ([#1414](https://github.com/tegojs/tego-standard/pull/1414)) (@sealday)
- workflow-trigger ([#1413](https://github.com/tegojs/tego-standard/pull/1413)) (@sealday)
- 工作流编辑器支持dayjs ([#1407](https://github.com/tegojs/tego-standard/pull/1407)) (@wjh)
- delete-koa-router ([#1411](https://github.com/tegojs/tego-standard/pull/1411)) (@yoona)
- **approval**: temp fixed approval form value ([#1401](https://github.com/tegojs/tego-standard/pull/1401)) (@bai.zixv)
- monaco require ([#1404](https://github.com/tegojs/tego-standard/pull/1404)) (@sealday)
- **approval**: change component register ([#1399](https://github.com/tegojs/tego-standard/pull/1399)) (@bai.zixv)
- **approval**: fixed sort by createAt ([#1396](https://github.com/tegojs/tego-standard/pull/1396)) (@bai.zixv)
- 批量生成pdf且可下载pdf ([#1394](https://github.com/tegojs/tego-standard/pull/1394)) (@yoona)
- **work-wechat**: missing deps @tachybase/database ([#1392](https://github.com/tegojs/tego-standard/pull/1392)) (@sealday)
- approval-mobile, date picker ([#1391](https://github.com/tegojs/tego-standard/pull/1391)) (@bai.zixv)
- 设置移动端时间组件默认值生效 ([#1388](https://github.com/tegojs/tego-standard/pull/1388)) (@wjh)
- wechat plugin not added ([#1389](https://github.com/tegojs/tego-standard/pull/1389)) (@sealday)
- workflow sync status now can be changed(using in your own risk), code mirror now support default value ([#1387](https://github.com/tegojs/tego-standard/pull/1387)) (@sealday)
- jscode, refactor ([#1379](https://github.com/tegojs/tego-standard/pull/1379)) (@bai.zixv)
- 修改移动端审批待办没有数据 ([#1376](https://github.com/tegojs/tego-standard/pull/1376)) (@wjh)
- approval-mobile, show task node & approval, update snapshot ([#1367](https://github.com/tegojs/tego-standard/pull/1367)) (@bai.zixv)
- 移动端我的发起和抄送没有数据 ([#1368](https://github.com/tegojs/tego-standard/pull/1368)) (@wjh)
- add default extension ui path ([#1371](https://github.com/tegojs/tego-standard/pull/1371)) (@sealday)
- update role migration ([#1366](https://github.com/tegojs/tego-standard/pull/1366)) (@sealday)
- table,sort ([#1361](https://github.com/tegojs/tego-standard/pull/1361)) (@bai.zixv)
- 修改移动端重新提交后表单状态 ([#1357](https://github.com/tegojs/tego-standard/pull/1357)) (@wjh)
- approval, fixed sort ([#1356](https://github.com/tegojs/tego-standard/pull/1356)) (@bai.zixv)
- docker build ([#1355](https://github.com/tegojs/tego-standard/pull/1355)) (@sealday)
- docker ([#1354](https://github.com/tegojs/tego-standard/pull/1354)) (@sealday)
- approval, show process & feat: approval, lastNode ([#1343](https://github.com/tegojs/tego-standard/pull/1343)) (@bai.zixv)
- dingtalk server using tachbase/client ([#1342](https://github.com/tegojs/tego-standard/pull/1342)) (@sealday)
- 同步移动端审批抄送 ([#1339](https://github.com/tegojs/tego-standard/pull/1339)) (@wjh)
- deps ([#1336](https://github.com/tegojs/tego-standard/pull/1336)) (@sealday)
- 修改主题出错 ([#1327](https://github.com/tegojs/tego-standard/pull/1327)) (@wjh)
- 保存区块模版时操作位置错误 ([#1329](https://github.com/tegojs/tego-standard/pull/1329)) (@wjh)
- token, fixed logic ([#1321](https://github.com/tegojs/tego-standard/pull/1321)) (@bai.zixv)
- data-mapping, fixed no data source ([#1315](https://github.com/tegojs/tego-standard/pull/1315)) (@bai.zixv)
- modal.confirm is not a function ([#1308](https://github.com/tegojs/tego-standard/pull/1308)) (@sealday)
- js-parse ([#1298](https://github.com/tegojs/tego-standard/pull/1298)) (@sealday)
- 修改手机端审批再发起功能 ([#1295](https://github.com/tegojs/tego-standard/pull/1295)) (@wjh)
- submit ([#1294](https://github.com/tegojs/tego-standard/pull/1294)) (@sealday)
- approval submit ([#1292](https://github.com/tegojs/tego-standard/pull/1292)) (@sealday)
- 修复手机端审批无法通过和状态没有显示 ([#1287](https://github.com/tegojs/tego-standard/pull/1287)) (@wjh)
- 修改手机端我的发起页面搜索没反应 ([#1280](https://github.com/tegojs/tego-standard/pull/1280)) (@wjh)
- approval, jsonata fix ([#1277](https://github.com/tegojs/tego-standard/pull/1277)) (@bai.zixv)
- approval, approvalExecution snapshot ([#1274](https://github.com/tegojs/tego-standard/pull/1274)) (@bai.zixv)
- approval, fix apply button bugs ([#1271](https://github.com/tegojs/tego-standard/pull/1271)) (@bai.zixv)
- 修复图表页面设置分页无效 ([#1257](https://github.com/tegojs/tego-standard/pull/1257)) (@wjh)
- 修复表格搜索不能用,表单删除样式显示 ([#1256](https://github.com/tegojs/tego-standard/pull/1256)) (@wjh)
- 修复改变数据范围后显示字段会重置 ([#1258](https://github.com/tegojs/tego-standard/pull/1258)) (@wjh)
- 审批, 自动刷新机制和撤回后更改子表格关联字段 ([#1260](https://github.com/tegojs/tego-standard/pull/1260)) (@bai.zixv)
- 筛选区块支持关联项直接添加 ([#1255](https://github.com/tegojs/tego-standard/pull/1255)) (@wjh)
- 修复图表筛选区块字段支持排序 ([#1252](https://github.com/tegojs/tego-standard/pull/1252)) (@wjh)
- invoice, rental sql invoice tax value ([#1250](https://github.com/tegojs/tego-standard/pull/1250)) (@bai.zixv)
- 修复汇总区块如果是最后一个删除，添加区块消失 #1243 (@wjh)
- 完善手机端审批功能 ([#1247](https://github.com/tegojs/tego-standard/pull/1247)) (@wjh)
- request user id ([#1227](https://github.com/tegojs/tego-standard/pull/1227)) (@sealday)
- 完善mobile级联组件的地区功能和只读样式 ([#1226](https://github.com/tegojs/tego-standard/pull/1226)) (@wjh)
- permission ([#1224](https://github.com/tegojs/tego-standard/pull/1224)) (@sealday)
- workflow http trigger ([#1222](https://github.com/tegojs/tego-standard/pull/1222)) (@sealday)
- plugin deps ([#1218](https://github.com/tegojs/tego-standard/pull/1218)) (@sealday)
- i18n of workflow/map ([#1210](https://github.com/tegojs/tego-standard/pull/1210)) (@sealday)
- departments ([#1203](https://github.com/tegojs/tego-standard/pull/1203)) (@sealday)
- 修复表格在没有拖拽排序下点击分页没有排序字段 ([#1202](https://github.com/tegojs/tego-standard/pull/1202)) (@wjh)
- api trigger twice ([#1192](https://github.com/tegojs/tego-standard/pull/1192)) (@sealday)
- action area ([#1188](https://github.com/tegojs/tego-standard/pull/1188)) (@sealday)
- workflow executions not show and format codes ([#1184](https://github.com/tegojs/tego-standard/pull/1184)) (@sealday)
- 修改子表格快捷添加的样式，审批表格的字段显示顺序，表格分页排序问题 ([#1183](https://github.com/tegojs/tego-standard/pull/1183)) (@wjh)
- quick edit styles ([#1177](https://github.com/tegojs/tego-standard/pull/1177)) (@sealday)
- quick edit ([#1176](https://github.com/tegojs/tego-standard/pull/1176)) (@sealday)
- mobile ui link ([#1173](https://github.com/tegojs/tego-standard/pull/1173)) (@sealday)
- collection undefined ([#1169](https://github.com/tegojs/tego-standard/pull/1169)) (@sealday)
- variable styles ([#1167](https://github.com/tegojs/tego-standard/pull/1167)) (@sealday)
- 修复移动端审批查看人名显示undefined，抄送人列表名字不正确 ([#1164](https://github.com/tegojs/tego-standard/pull/1164)) (@wjh)
- submit to workflow error ([#1163](https://github.com/tegojs/tego-standard/pull/1163)) fix #1162 (@sealday)
- theme config ([#1161](https://github.com/tegojs/tego-standard/pull/1161)) (@sealday)
- 修复移动端快速添加功能 ([#1153](https://github.com/tegojs/tego-standard/pull/1153)) (@wjh)
- 修改结算单其他费用的计算逻辑 ([#1146](https://github.com/tegojs/tego-standard/pull/1146)) (@wjh)
- 修改移动端抄送我的配置和界面 ([#1142](https://github.com/tegojs/tego-standard/pull/1142)) (@wangjiahui)
- 修复表单快速添加和弹窗添加功能 ([#1141](https://github.com/tegojs/tego-standard/pull/1141)) (@wjh)
- notifiedPerson length ([#1137](https://github.com/tegojs/tego-standard/pull/1137)) (@sealday)
- 修改子表格快速添加搜索bug,添加分类的所有选项 ([#1129](https://github.com/tegojs/tego-standard/pull/1129)) (@wjh)
- subtable search ([#1124](https://github.com/tegojs/tego-standard/pull/1124)) (@sealday)
- sub-form to subform ([#1121](https://github.com/tegojs/tego-standard/pull/1121)) (@sealday)
- popup record ([#1116](https://github.com/tegojs/tego-standard/pull/1116)) (@sealday)
- 修改弹窗中的模版行为按钮固定在上面 ([#1114](https://github.com/tegojs/tego-standard/pull/1114)) (@wjh)
- get app info ([#1107](https://github.com/tegojs/tego-standard/pull/1107)) (@sealday)
- 修改移动端下拉框适配自定义数据选择 ([#1102](https://github.com/tegojs/tego-standard/pull/1102)) (@wjh)
- table appends ([#1099](https://github.com/tegojs/tego-standard/pull/1099)) (@sealday)
- plugin-workflow, import Instruction from nodes ([#1095](https://github.com/tegojs/tego-standard/pull/1095)) (@bai.zixv)
- workflow plugins ([#1094](https://github.com/tegojs/tego-standard/pull/1094)) (@sealday)
- 修改标签没有对应颜色，审批页面没有显示正确的创建人名称 ([#1090](https://github.com/tegojs/tego-standard/pull/1090)) (@wjh)
- use before init group block ([#1085](https://github.com/tegojs/tego-standard/pull/1085)) (@sealday)
- design menu not show ([#1083](https://github.com/tegojs/tego-standard/pull/1083)) (@sealday)
- 修复审批页面标签不是翻译后的 ([#1080](https://github.com/tegojs/tego-standard/pull/1080)) (@wjh)
- 修改执行处理没有显示数据，把审核内容和流程放在同一页面 ([#1077](https://github.com/tegojs/tego-standard/pull/1077)) (@wangjiahui)
- code field ([#1071](https://github.com/tegojs/tego-standard/pull/1071)) (@bai.zixv)
- template-loading ([#1072](https://github.com/tegojs/tego-standard/pull/1072)) close #626 (@sealday)
- 修复手机端我的发起出错 ([#1073](https://github.com/tegojs/tego-standard/pull/1073)) (@wjh)
- show count traffic ([#1062](https://github.com/tegojs/tego-standard/pull/1062)) (@bai.zixv)
- required tables ([#1063](https://github.com/tegojs/tego-standard/pull/1063)) (@sealday)
- merge dev error ([#1060](https://github.com/tegojs/tego-standard/pull/1060)) (@bai.zixv)
- entry ([#1058](https://github.com/tegojs/tego-standard/pull/1058)) (@sealday)
- 完善审批工作流界面配置 ([#1057](https://github.com/tegojs/tego-standard/pull/1057)) (@wjh)
- mobile-client, showCount ([#1055](https://github.com/tegojs/tego-standard/pull/1055)) (@bai.zixv)
- 优化移动端没有页面的效果 ([#1053](https://github.com/tegojs/tego-standard/pull/1053)) (@wjh)
- 修复手机端表单使用相对应的组件 ([#1054](https://github.com/tegojs/tego-standard/pull/1054)) (@wjh)
- 完善审批摘要内容 ([#1051](https://github.com/tegojs/tego-standard/pull/1051)) (@wjh)
- lock ([#1052](https://github.com/tegojs/tego-standard/pull/1052)) (@sealday)
- current user style error ([#1049](https://github.com/tegojs/tego-standard/pull/1049)) (@sealday)
- props disabled ([#1047](https://github.com/tegojs/tego-standard/pull/1047)) (@sealday)
- 完善移动端审批组件 ([#1042](https://github.com/tegojs/tego-standard/pull/1042)) (@wjh)
- bulk update keys should obtained when clicked ([#1040](https://github.com/tegojs/tego-standard/pull/1040)) (@sealday)
- plugin-approval, kit add ([#1038](https://github.com/tegojs/tego-standard/pull/1038)) (@bai.zixv)
- duplicated designer setting items ([#1028](https://github.com/tegojs/tego-standard/pull/1028)) (@sealday)
- comment plugins ([#1023](https://github.com/tegojs/tego-standard/pull/1023)) (@sealday)
- core, layoutDirection ([#1013](https://github.com/tegojs/tego-standard/pull/1013)) (@bai.zixv)
- homepage ([#1011](https://github.com/tegojs/tego-standard/pull/1011)) (@sealday)
- 修改结算单人工录入计算逻辑 ([#1007](https://github.com/tegojs/tego-standard/pull/1007)) (@wjh)
- plugin setting use the same name ([#1005](https://github.com/tegojs/tego-standard/pull/1005)) (@sealday)
- 修改结算单报错问题 ([#998](https://github.com/tegojs/tego-standard/pull/998)) (@wjh)
- 修复异常死循环问题 ([#991](https://github.com/tegojs/tego-standard/pull/991)) (@sealday)
- 修复不稳定的更新状态和错误的 preset ([#985](https://github.com/tegojs/tego-standard/pull/985)) (@sealday)
- 统一注释改成备注合并 ([#977](https://github.com/tegojs/tego-standard/pull/977)) (@wjh)
- 修改侧边栏滑动超出后出现 ([#966](https://github.com/tegojs/tego-standard/pull/966)) (@wjh)
- 修复自定义标题标签不显示 ([#963](https://github.com/tegojs/tego-standard/pull/963)) (@wjh)
- 修复多对多筛选中间表无效 ([#962](https://github.com/tegojs/tego-standard/pull/962)) (@wjh)
- 修改录单的维修赔偿级联点击能显示名称，修改级联组价查看显示标题 ([#958](https://github.com/tegojs/tego-standard/pull/958)) (@wjh)
- plugin-mobile-client, support set data scope ([#956](https://github.com/tegojs/tego-standard/pull/956)) (@bai.zixv)
- 修改合同筛选方案明细的条件 ([#950](https://github.com/tegojs/tego-standard/pull/950)) (@wjh)
- 修改组件创建树形结构时默认为级联组件 ([#948](https://github.com/tegojs/tego-standard/pull/948)) (@wjh)
- view contract ([#949](https://github.com/tegojs/tego-standard/pull/949)) (@sealday)
- 修改录单时产品没有合同显示全部 ([#946](https://github.com/tegojs/tego-standard/pull/946)) (@wjh)
- 修改自定义标题标签显示 ([#943](https://github.com/tegojs/tego-standard/pull/943)) (@wjh)
- 处理调拨单类型显示不正确问题 (@hello@lv)
- cascader filter ([#940](https://github.com/tegojs/tego-standard/pull/940)) (@sealday)
- plugin-core, collection compatibility ([#935](https://github.com/tegojs/tego-standard/pull/935)) (@bai.zixv)
- 出入库查询视图 ([#936](https://github.com/tegojs/tego-standard/pull/936)) (@hello@lv)
- preset error ([#930](https://github.com/tegojs/tego-standard/pull/930)) (@sealday)
- translation in mobile ([#929](https://github.com/tegojs/tego-standard/pull/929)) (@sealday)
- mobile-scroll ([#928](https://github.com/tegojs/tego-standard/pull/928)) (@bai.zixv)
- 修改侧边菜单没有滑动效果 ([#925](https://github.com/tegojs/tego-standard/pull/925)) (@wjh)
- current object in drawersubtable ([#924](https://github.com/tegojs/tego-standard/pull/924)) (@sealday)
- 修改汇总区块兼容视图没有字段的情况 ([#923](https://github.com/tegojs/tego-standard/pull/923)) (@wjh)
- load schema not working ([#919](https://github.com/tegojs/tego-standard/pull/919)) (@sealday)
- plugin-core, CalcResult, fix childrenType ([#888](https://github.com/tegojs/tego-standard/pull/888)) (@bai.zixv)
- 修改级联选择在置空后没有及时清除表单内容 close #831 ([#866](https://github.com/tegojs/tego-standard/pull/866)) (@wjh)
- plugin-approval, trigger data ([#861](https://github.com/tegojs/tego-standard/pull/861)) (@bai.zixv)
- sql, view_invoices_tax, convert the month of result to utc ([#859](https://github.com/tegojs/tego-standard/pull/859)) (@bai.zixv)
- plugin-rental,view_invoices_taxs-sql, date zone set shanghai ([#849](https://github.com/tegojs/tego-standard/pull/849)) (@bai.zixv)
- **plugin-workflow-manual**: flatten assignees, assignees parsing bug ([#837](https://github.com/tegojs/tego-standard/pull/837)) (@bai.zixv)
- plugin-approval, submit approval or reject faild ([#835](https://github.com/tegojs/tego-standard/pull/835)) (@bai.zixv)
- 筛选结算单订单类型只有租赁类型 ([#829](https://github.com/tegojs/tego-standard/pull/829)) (@wjh)
- old version get stream ([#825](https://github.com/tegojs/tego-standard/pull/825)) (@sealday)
- setting block cant search items ([#814](https://github.com/tegojs/tego-standard/pull/814)) (@sealday)
- fix bug, AutoComplete, add fault tolerant ([#806](https://github.com/tegojs/tego-standard/pull/806)) (@bai.zixv)
- support attachment showCount set ([#801](https://github.com/tegojs/tego-standard/pull/801)) (@bai.zixv)
- 结算表无关联费用支持其他类型 ([#799](https://github.com/tegojs/tego-standard/pull/799)) (@wjh)
- 结算表本期明细显示数量为0的内容 ([#796](https://github.com/tegojs/tego-standard/pull/796)) (@wjh)
- 修复视图, 当日期没有数据时,前端显示Invalid Date ([#767](https://github.com/tegojs/tego-standard/pull/767)) (@bai.zixv)
- 结算单显示具体规格逻辑修复 ([#770](https://github.com/tegojs/tego-standard/pull/770)) (@wjh)
- improve release process ([#773](https://github.com/tegojs/tego-standard/pull/773)) (@sealday)
- 结算单录单模块调整后没有显示录在明细中的无关联费用 close #764 ([#765](https://github.com/tegojs/tego-standard/pull/765)) (@wjh)
- createAt field error (@sealday)
- import es modules error (@sealday)
- update dockerfile (@sealday)
- plugin add is ok now (@sealday)
- 修复级联选择在编辑的时候没有默认值 close #633 ([#749](https://github.com/tegojs/tego-standard/pull/749)) (@wjh)
- default version is 0.0.1 (@sealday)
- 重命名图标搜索文件 ([#745](https://github.com/tegojs/tego-standard/pull/745)) (@bai.zixv)
- 优化筛选组件文本情况时加2s延迟，轮播图没有数据时添加提示 close #735 ([#738](https://github.com/tegojs/tego-standard/pull/738)) (@wjh)
- 修改结算单合并规则的订单数量不对 ([#734](https://github.com/tegojs/tego-standard/pull/734)) (@wjh)
- 修复自定义组件下拉框没有自定义显示选项 ([#730](https://github.com/tegojs/tego-standard/pull/730)) (@wjh)
- 修复mobile选择类型不能用的情况 fix #723 (@wjh)
- multi app start error (@sealday)
- 修复数据表自动编码没有提交按钮的bug, 去除布局组件 ([#722](https://github.com/tegojs/tego-standard/pull/722)) (@bai.zixv)
- support fuzzy search in cascader & fix undefined label ([#718](https://github.com/tegojs/tego-standard/pull/718)) (@sealday)
- 合同结算单结束时间加一天减一毫秒，取当天的结束时间 ([#711](https://github.com/tegojs/tego-standard/pull/711)) (@hello@lv)
- 处理同名组件选择异常情况，文本切换组件阈值，时间选择具体范围 ([#712](https://github.com/tegojs/tego-standard/pull/712)) Co-authored-by: wjh <wwwjh0710@163.com> Co-committed-by: wjh <wwwjh0710@163.com> (@wjh)
- build (@sealday)
- ignore core/cli/bin error (@sealday)
- import json warnning (@sealday)
- 修改结算单导出Excel名称 ([#697](https://github.com/tegojs/tego-standard/pull/697)) fix #696 (@wjh)
- 修改筛选页面自定义筛选不能用 ([#698](https://github.com/tegojs/tego-standard/pull/698)) fix #699 (@wjh)
- 修复组件移动别的区块后出错 修复单选框点击出错 ([#680](https://github.com/tegojs/tego-standard/pull/680)) (@wjh)
- 调整mobile类型选择组件 ([#670](https://github.com/tegojs/tego-standard/pull/670)) Co-authored-by: wjh <wwwjh0710@163.com> Co-committed-by: wjh <wwwjh0710@163.com> (@wjh)
- mobile icon build error (@sealday)
- version mismatch (@sealday)
- upgrade (@sealday)
- 合同结算单打印预览单价计算、费用赔偿计算相关，出入库内容字段报错 (@wjh)
- 临时修复,模板第一次进入无法加载 ([#655](https://github.com/tegojs/tego-standard/pull/655)) (@bai.jingfeng)
- 修复分页问题 ([#631](https://github.com/tegojs/tego-standard/pull/631)) (@bai.jingfeng)
- 修改结算单产品计算逻辑 ([#630](https://github.com/tegojs/tego-standard/pull/630)) (@wjh)
- source id & subtable sort (@sealday)
- delete residual packages (@sealday)
- base branch set dev (@sealday)
- 修改结算单产品计算逻辑 ([#619](https://github.com/tegojs/tego-standard/pull/619)) (@wjh)
- 上游跟进,(fix: sort params missing when switch page numbers #3906) (@bai.jingfeng)
- 上游跟进, source id为null的情况,fix-source id null #3917 (@bai.jingfeng)
- 复制修复 (@bai.jingfeng)
- 上游跟踪,fix- getSourceKeyByAssocation #3947 (@bai.jingfeng)
- 修改结算单计算逻辑 ([#612](https://github.com/tegojs/tego-standard/pull/612)) (@wjh)
- 修复更新antd后的导航图标样式异常 (@wjh)
- 配置字段,显示一对一的关联表的筛选项 (@bai.jingfeng)
- 修改汇总区块不格式化文本类型 (@wjh)
- add menu (@sealday)
- import error (@sealday)
- should shadow merge (@sealday)
- 数据关联表引用自己的情况不显示内容-同步官方, 发布后需要重新配置区块 (@bai.jingfeng)
- 日期提交给后端设置为utc类型,单选类型有误差,后期需要系统整理日期格式问题 (@bai.jingfeng)
- 修复多标签页标题问题 (@sealday)
- multi app start error (@sealday)
- @formily/json-schema import (@sealday)
- 消息通知点击已读，提示消息为清空 fix #467 (@lyx)
- 财务-明细查询,本公司,添加设置数据范围, 同步官方 ([#565](https://github.com/tegojs/tego-standard/pull/565)) (@bai.jingfeng)
- formily load error (@sealday)
- formily version (@sealday)

### 🔄 Changed

- module web ([#1908](https://github.com/tegojs/tego-standard/pull/1908)) (@sealday)
- rename packages ([#1907](https://github.com/tegojs/tego-standard/pull/1907)) (@sealday)
- unify @formily/x ([#1906](https://github.com/tegojs/tego-standard/pull/1906)) (@sealday)
- approval ui & system setting translations ([#1905](https://github.com/tegojs/tego-standard/pull/1905)) (@sealday)
- rename certain package names to better reflect their actual intent ([#1896](https://github.com/tegojs/tego-standard/pull/1896)) (@sealday)
- **data-source**: datasource migrate table to table-v2 ([#1881](https://github.com/tegojs/tego-standard/pull/1881)) (@WinC159)
- merge mobile client to client ([#1886](https://github.com/tegojs/tego-standard/pull/1886)) (@sealday)
- clean codes ([#1884](https://github.com/tegojs/tego-standard/pull/1884)) (@sealday)
- **hera**: clean codes ([#1880](https://github.com/tegojs/tego-standard/pull/1880)) (@sealday)
- remove unused notifications modules (@sealday)
- remove prototype pdf editor (merged into cloud components) (@sealday)
- **hera**: clean codes ([#1865](https://github.com/tegojs/tego-standard/pull/1865)) (@sealday)
- add custom icon for node ([#1855](https://github.com/tegojs/tego-standard/pull/1855)) (@bai.zixv)
- rename packages ([#1844](https://github.com/tegojs/tego-standard/pull/1844)) (@sealday)
- workflow module, split default node view ([#1813](https://github.com/tegojs/tego-standard/pull/1813)) (@bai.zixv)
- **client**: migrate useCreateActionProps & submit button operation from hera to client ([#1789](https://github.com/tegojs/tego-standard/pull/1789)) (@wjh)
- **workflow**: workflow execution move to table v2 ([#1790](https://github.com/tegojs/tego-standard/pull/1790)) (@fanyukun)
- approval ([#1796](https://github.com/tegojs/tego-standard/pull/1796)) (@bai.zixv)
- approval ([#1794](https://github.com/tegojs/tego-standard/pull/1794)) (@bai.zixv)
- remove compatible schema ([#1784](https://github.com/tegojs/tego-standard/pull/1784)) (@sealday)
- **workflow**: workflow migrate Table to TableV2 ([#1761](https://github.com/tegojs/tego-standard/pull/1761)) (@fanyukun)
- **approval**: rename package ([#1779](https://github.com/tegojs/tego-standard/pull/1779)) (@sealday)
- notice area with antd alert component ([#1775](https://github.com/tegojs/tego-standard/pull/1775)) (@sealday)
- approval ([#1772](https://github.com/tegojs/tego-standard/pull/1772)) (@bai.zixv)
- approval ([#1769](https://github.com/tegojs/tego-standard/pull/1769)) (@bai.zixv)
- **approval**: approval ([#1749](https://github.com/tegojs/tego-standard/pull/1749)) (@bai.zixv)
- **client**: separate out requirejs ([#1754](https://github.com/tegojs/tego-standard/pull/1754)) (@sealday)
- **client**: tachybase client self ref ([#1748](https://github.com/tegojs/tego-standard/pull/1748)) (@sealday)
- **approval**: approval block launch schema ([#1735](https://github.com/tegojs/tego-standard/pull/1735)) (@bai.zixv)
- rename to modules ([#1729](https://github.com/tegojs/tego-standard/pull/1729)) (@sealday)
- change js to ts (@sealday)
- change approval file name ([#1720](https://github.com/tegojs/tego-standard/pull/1720)) (@bai.zixv)
- **approval**: change approval file ([#1719](https://github.com/tegojs/tego-standard/pull/1719)) (@bai.zixv)
- **lint**: remove unused lint deps ([#1718](https://github.com/tegojs/tego-standard/pull/1718)) (@sealday)
- mv apps from packages to apps ([#1708](https://github.com/tegojs/tego-standard/pull/1708)) (@sealday)
- ai assistant and cloud components ([#1694](https://github.com/tegojs/tego-standard/pull/1694)) (@sealday)
- mv @hera plugins to @tachybase namespaces ([#1683](https://github.com/tegojs/tego-standard/pull/1683)) (@sealday)
- data source ([#1665](https://github.com/tegojs/tego-standard/pull/1665)) (@sealday)
- 重构下拉菜单，统一模态窗和抽屉的 UI，新增快捷入口区块 ([#1649](https://github.com/tegojs/tego-standard/pull/1649)) (@sealday)
- **di**: prepare next framework improvement ([#1634](https://github.com/tegojs/tego-standard/pull/1634)) (@sealday)
- **client**: unify classnames ([#1594](https://github.com/tegojs/tego-standard/pull/1594)) (@sealday)
- **data-source-external**: rename package name ([#1578](https://github.com/tegojs/tego-standard/pull/1578)) (@sealday)
- block init names and design icons ([#1553](https://github.com/tegojs/tego-standard/pull/1553)) (@sealday)
- **department**: dev ([#1492](https://github.com/tegojs/tego-standard/pull/1492)) (@bai.zixv)
- **telemetry**: do not init telemetry if disabled ([#1437](https://github.com/tegojs/tego-standard/pull/1437)) (@TomyJan)
- remove demo ([#1426](https://github.com/tegojs/tego-standard/pull/1426)) (@sealday)
- purge api regular ([#1415](https://github.com/tegojs/tego-standard/pull/1415)) (@sealday)
- webhooks rename to dispatchers ([#1385](https://github.com/tegojs/tego-standard/pull/1385)) (@sealday)
- approval, actions ([#1346](https://github.com/tegojs/tego-standard/pull/1346)) (@bai.zixv)
- approval, rename ([#1319](https://github.com/tegojs/tego-standard/pull/1319)) (@bai.zixv)
- remove notice and approval ([#1276](https://github.com/tegojs/tego-standard/pull/1276)) (@sealday)
- prepare saas ([#1239](https://github.com/tegojs/tego-standard/pull/1239)) (@sealday)
- workflow #1229 (@sealday)
- webhook names ([#1220](https://github.com/tegojs/tego-standard/pull/1220)) (@sealday)
- optimize bind workflow process, move code mirrors to components and add lib to webhook ([#1219](https://github.com/tegojs/tego-standard/pull/1219)) (@sealday)
- workflow/webhook/department ([#1207](https://github.com/tegojs/tego-standard/pull/1207)) (@sealday)
- deps approvals ([#1206](https://github.com/tegojs/tego-standard/pull/1206)) (@sealday)
- departments ([#1205](https://github.com/tegojs/tego-standard/pull/1205)) (@sealday)
- block-item form-item card-item variable ([#1165](https://github.com/tegojs/tego-standard/pull/1165)) (@sealday)
- core-libs ([#1158](https://github.com/tegojs/tego-standard/pull/1158)) (@sealday)
- from hera-core to @tachybase/plugin-workflow ([#1156](https://github.com/tegojs/tego-standard/pull/1156)) (@sealday)
- processing style improve ([#1140](https://github.com/tegojs/tego-standard/pull/1140)) (@sealday)
- client ([#1092](https://github.com/tegojs/tego-standard/pull/1092)) (@sealday)
- @hera/plugin-core ([#1081](https://github.com/tegojs/tego-standard/pull/1081)) (@sealday)
- client build in plugins ([#1067](https://github.com/tegojs/tego-standard/pull/1067)) (@sealday)
- types correct ([#1056](https://github.com/tegojs/tego-standard/pull/1056)) (@sealday)
- @hera/plugin-core, departments-plugin ([#979](https://github.com/tegojs/tego-standard/pull/979)) (@bai.zixv)
- migrate names ([#1050](https://github.com/tegojs/tego-standard/pull/1050)) (@sealday)
- @emotion/css to antd-style ([#1044](https://github.com/tegojs/tego-standard/pull/1044)) (@sealday)
- migrate @emotion/css to antd-style ([#1043](https://github.com/tegojs/tego-standard/pull/1043)) (@sealday)
- replace @emotion/css with @tachybase/client, support import sort ([#1039](https://github.com/tegojs/tego-standard/pull/1039)) (@sealday)
- multi app and plugins ([#1021](https://github.com/tegojs/tego-standard/pull/1021)) (@sealday)
- individual homepage plugin ([#1003](https://github.com/tegojs/tego-standard/pull/1003)) (@sealday)
- @hera/plugin-core @tachybase/schema, remove unused plugin-charts ([#887](https://github.com/tegojs/tego-standard/pull/887)) (@sealday)
- optimize context menu and clean @hera/plugin-core ([#886](https://github.com/tegojs/tego-standard/pull/886)) (@sealday)
- migrate assistant/page-style/hera-version ([#817](https://github.com/tegojs/tego-standard/pull/817)) (@sealday)
- excel 部分重构，优化弹窗体验 ([#598](https://github.com/tegojs/tego-standard/pull/598)) (@bai.jingfeng)
- migrate formily internal methods into @nocobase/schema (@sealday)
- 跟踪上游,(refactor: change useProps to x-use-component-props ([#3853](https://github.com/tegojs/tego-standard/pull/3853))) ([#629](https://github.com/tegojs/tego-standard/pull/629)) (@bai.jingfeng)
- remove unsed formula plugins (@sealday)
- **approval**: migrate approval plugin ([#1773](https://github.com/tegojs/tego-standard/pull/1773)) (@bai.zixv)
- improve lint ([#1717](https://github.com/tegojs/tego-standard/pull/1717)) (@sealday)
- 工作流 HTTP给个写备注的地方. 以防后续不知道节点数据含义 ([#1672](https://github.com/tegojs/tego-standard/pull/1672)) (@Toby)
- **plugin-wechat-auth**: add to tachybase preset ([#1520](https://github.com/tegojs/tego-standard/pull/1520)) (@TomyJan)
- **plugin-logger**: permission control & log preview ([#1491](https://github.com/tegojs/tego-standard/pull/1491)) (@TomyJan)
- **telemetry**: use self hosted instrumentation lib ([#1446](https://github.com/tegojs/tego-standard/pull/1446)) (@TomyJan)
- **telemetry**: load telemetry asap ([#1431](https://github.com/tegojs/tego-standard/pull/1431)) (@TomyJan)
- **build**: do not output red log plz ([#1406](https://github.com/tegojs/tego-standard/pull/1406)) (@TomyJan)
- user delete permission judgement ([#1363](https://github.com/tegojs/tego-standard/pull/1363)) (@TomyJan)
- form item ([#1171](https://github.com/tegojs/tego-standard/pull/1171)) (@sealday)
- optimize pdf load ([#827](https://github.com/tegojs/tego-standard/pull/827)) (@sealday)

### 📝 Documentation

- update readme (@sealday)
- update readme.md (@sealday)
- update readme (@sealday)
- fix png (@sealday)
- add some cases (@sealday)
- update readme (@sealday)
- update readme (@sealday)
- update readme (@sealday)
- update readme (@sealday)
- update README.md (@sealday)
- readme.md (@sealday)
- update readme.md (@sealday)
- update readme.md ([#1807](https://github.com/tegojs/tego-standard/pull/1807)) (@sealday)
- update readme.md (@sealday)
- update readme ([#1756](https://github.com/tegojs/tego-standard/pull/1756)) (@sealday)
- update license (@sealday)
- update readme.md (@sealday)
- update readme.md ([#1751](https://github.com/tegojs/tego-standard/pull/1751)) (@sealday)
- update readme ([#1663](https://github.com/tegojs/tego-standard/pull/1663)) (@sealday)
- update readme ([#1656](https://github.com/tegojs/tego-standard/pull/1656)) (@sealday)
- update README.EN-US.md ([#1640](https://github.com/tegojs/tego-standard/pull/1640)) (@sealday)
- update README.md ([#1639](https://github.com/tegojs/tego-standard/pull/1639)) (@sealday)
- update readme ([#1618](https://github.com/tegojs/tego-standard/pull/1618)) (@sealday)
- readme ([#1601](https://github.com/tegojs/tego-standard/pull/1601)) (@sealday)
- new readme ([#1596](https://github.com/tegojs/tego-standard/pull/1596)) (@sealday)
- update readme ([#1595](https://github.com/tegojs/tego-standard/pull/1595)) (@sealday)


[Unreleased]: https://github.com/tegojs/tego-standard/compare/v1.6.6...HEAD
[1.6.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.6.6
[1.6.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.6.5
[1.6.4]: https://github.com/tegojs/tego-standard/releases/tag/v1.6.4
[1.6.2]: https://github.com/tegojs/tego-standard/releases/tag/v1.6.2
[1.6.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.6.1
[1.6.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.6.0
[1.5.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.5.1
[1.5.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.5.0
[1.4.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.4.0
[1.3.27]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.27
[1.3.26]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.26
[1.3.25]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.25
[1.3.24]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.24
[1.3.23]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.23
[1.3.22]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.22
[1.3.21]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.21
[1.3.20]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.20
[1.3.19]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.19
[1.3.18]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.18
[1.3.17]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.17
[1.3.16]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.16
[1.3.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.15
[1.3.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.14
[1.3.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.13
[1.3.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.12
[1.3.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.11
[1.3.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.10
[1.3.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.8
[1.3.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.7
[1.3.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.6
[1.3.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.5
[1.3.4]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.4
[1.3.2]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.2
[1.3.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.1
[1.3.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.0
[1.2.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.15
[1.2.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.14
[1.2.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.13
[1.2.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.12
[1.2.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.11
[1.2.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.10
[1.2.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.8
[1.2.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.7
[1.2.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.6
[1.2.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.5
[1.2.3]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.3
[1.2.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.0
[1.1.33]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.33
[1.1.30]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.30
[1.1.29]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.29
[1.1.24]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.24
[1.1.23]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.23
[1.1.22]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.22
[1.1.21]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.21
[1.1.20]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.20
[1.1.17]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.17
[1.1.16]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.16
[1.1.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.15
[1.1.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.14
[1.1.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.13
[1.1.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.12
[1.1.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.11
[1.1.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.10
[1.1.9]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.9
[1.1.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.8
[1.1.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.7
[1.1.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.6
[1.1.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.5
[1.1.4]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.4
[1.1.3]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.3
[1.1.2]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.2
[1.1.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.1
[1.1.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.0
[1.0.25]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.25
[1.0.23]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.23
[1.0.22]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.22
[1.0.20]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.20
[1.0.19]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.19
[1.0.18]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.18
[1.0.17]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.17
[1.0.16]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.16
[1.0.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.15
[1.0.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.14
[1.0.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.13
[1.0.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.12
[1.0.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.11
[1.0.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.10
[1.0.9]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.9
[1.0.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.8
[1.0.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.7
[1.0.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.6
[1.0.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.5
[1.0.4]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.4
[1.0.3]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.3
[1.0.2]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.2
[1.0.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.1
[1.0.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.0
[0.23.66]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.66
[0.23.65]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.65
[0.23.64]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.64
[0.23.63]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.63
[0.23.62]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.62
[0.23.61]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.61
[0.23.60]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.60
[0.23.59]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.59
[0.23.58]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.58
[0.23.57]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.57
[0.23.56]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.56
[0.23.55]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.55
[0.23.54]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.54
[0.23.53]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.53
[0.23.52]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.52
[0.23.51]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.51
[0.23.50]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.50
[0.23.49]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.49
[0.23.48]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.48
[0.23.47]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.47
[0.23.46]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.46
[0.23.45]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.45
[0.23.44]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.44
[0.23.43]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.43
[0.23.42]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.42
[0.23.41]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.41
[0.23.40]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.40
[0.23.39]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.39
[0.23.38]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.38
[0.23.37]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.37
[0.23.36]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.36
[0.23.35]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.35
[0.23.34]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.34
[0.23.33]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.33
[0.23.32]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.32
[0.23.30]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.30
[0.23.29]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.29
[0.23.28]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.28
[0.23.27]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.27
[0.23.26]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.26
[0.23.25]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.25
[0.23.23]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.23
[0.23.22]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.22
[0.23.21]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.21
[0.23.20]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.20
[0.23.18]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.18
[0.23.17]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.17
[0.23.16]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.16
[0.23.15]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.15
[0.23.11]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.11
[0.23.10]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.10
[0.23.9]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.9
[0.23.8]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.8
[0.23.7]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.7
[0.23.5]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.5
[0.23.4]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.4
[0.23.3]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.3
[0.23.2]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.2
[0.23.1]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.1
[0.23.0]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.0
[0.22.85]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.85
[0.22.84]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.84
[0.22.83]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.83
[0.22.82]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.82
[0.22.81]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.81
[0.22.75]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.75
[0.22.72]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.72
[0.22.69]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.69
[0.22.62]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.62
[0.0.3]: https://github.com/tegojs/tego-standard/releases/tag/v0.0.3