<div align="center">

<img src="../assets/logo.svg" alt="APICover logosu" width="72" />

# APICover

**Her dalı kapsa. Her varyantı. Production'dan önce.**

ASP.NET Core HTTP API'leri için görsel durum-uzayı (state-space) test aracı.

[English](../en/README.md) · [Русский](../ru/README.md) · [apicover.com](https://apicover.com)

</div>

---

## APICover nedir?

APICover, ASP.NET Core HTTP API'leri için süreç içi (in-process) çalışan bir **durum-uzayı taraması (state-space exploration) motorudur**. Bir REST API'nin gözlemlenebilir davranış kümesi, endpoint imzalarının değil, *girdi kombinasyonları × yürütme sırası × paylaşılan durum* üçlüsünün fonksiyonudur. OpenAPI/Swagger bu uzayın yalnızca izdüşümünü — statik sözleşme yüzeyini — belgeler; iş akışlarının dallanma topolojisi (ödeme retry politikaları, idempotency ihlalleri, soft-delete kaskadları, race'e açık slug üretimi) hiçbir spec formatında temsil edilmez. APICover'ın var olma sebebi tam olarak bu temsil boşluğudur.

Mimari olarak üç katmanda çalışır:

**1. Canlı keşif (live discovery).** APICover bir proxy, sidecar ya da harici ajan değildir; `AddAPICover()` ile DI konteynerine, `UseAPICover()` ile middleware pipeline'ına kaydolur. Endpoint envanterini ASP.NET Core'un kendi `IApiDescriptionGroupCollectionProvider` soyutlamasından okur — yani framework'ün routing katmanının çözdüğü gerçeklikle birebir aynı kaynaktan beslenir. Elle sürdürülen spec dosyası, drift riski, codegen adımı yoktur. Bunun üzerine **IL seviyesinde statik çağrı grafiği analizi** ekler: her endpoint'in derlenmiş gövdesini yürüyerek DI arayüz dispatch'lerini somut implementasyonlara çözer, dış HTTP çağrılarını ve veritabanı sınırlarını (I/O boundary) sınıflandırır. Kara kutuyu dışarıdan içeriye doğru şeffaflaştırır.

**2. Deklaratif senaryo kompozisyonu.** Senaryolar, tuval üzerinde kurulan bir **DAG**'dır (directed acyclic graph): düğümler HTTP invokasyonları, kenarlar veri ve sıralama bağımlılıkları. Motor, grafı **topolojik sıralamayla eşzamanlı (concurrent) olarak** planlar — bağımsız dallar paralel yürür. Düğümler arası veri akışı imperative glue kodu yerine **JSONLogic** ifadeleriyle tanımlanır: path, query, header ve body şablonları, upstream düğümlerin yanıtlarını taşıyan canlı `RunContext` üzerinde (`nodes.<id>.response.*`) çözümlenir. Fixture yok, serialization boilerplate'i yok — veri bağlama tamamen deklaratiftir.

**3. Kombinatoryal dallanma (branched execution).** Ayırt edici mekanizma **Case Set**'tir: herhangi bir düğüme bağlanan, N varyantlık, alan-bazlı override taşıyan bir varyant kümesi. Motor yürütme o düğüme ulaştığında **fork semantiği** uygular — `RunContext`'i varyant başına derin-kopyalar (deep clone) ve downstream alt ağacı her dal için izole şekilde yeniden yürütür. Case Set'ler iç içe geçtiğinde dallar **kartezyen çarpımla** çoğalır: login'de 3 × checkout'ta 2 varyant = tek tetiklemede 6 tam-izli (fully-traced), bağımsız assertion'lı yürütme dalı. Kombinatoryal patlama kontrolsüz değildir: **pre-flight branch estimator** çalıştırma öncesi dal sayısını hesaplayıp limit aşan runları reddeder; çalışma zamanında semaphore tabanlı eşzamanlılık sınırı ve atomik sayaçlar (`MaxBranches=128`, `MaxConcurrentBranches=16`, `MaxLeafInvocations=4000`) ikinci savunma hattını oluşturur.

Her dal `(nodeId, BranchPath)` anahtarıyla kendi trace'ini ve pass/fail verdiktini üretir; dal yaşam döngüsü SSE üzerinden gerçek zamanlı yayınlanır. Nihai çıktı, API'nin tanımlı girdi uzayı altında sergileyebileceği davranışların **ağaç biçimli kapsam matrisidir** — Postman'de aynı koleksiyonu on iki kez klonlayıp elle senkronize ederek taklit etmeye çalıştığınız şeyin, motor tarafından türetilen birinci sınıf karşılığı.

## Neyi amaçlıyor?

APICover'ın hedef kullanıcısı, çalışan bir ASP.NET Core API'si teslim etmiş ama altındaki kodun tamamını yazmamış ya da tamamına hâkim olmayan geliştiricidir — özellikle AI destekli üretilen kod tabanlarında bu giderek yaygınlaşan bir durum. Swagger'a bakıp endpoint listesi görürsünüz; ama sistemin davranışları (satın alma akışı, kullanıcı provizyonlama, ödeme retry'ı) hiçbir yerde görünür değildir.

Mevcut araçların her biri API testinin tek bir dilimini kapsar:

| | Canlı keşif | Görsel akış | Dallanan durum-uzayı | Dal başına regresyon |
| --- | :---: | :---: | :---: | :---: |
| Postman / Insomnia | — | — | — | — |
| Cypress / Playwright | — | — | — | — |
| k6 / JMeter (yük) | — | — | — | — |
| WireMock / MockServer | — | — | — | — |
| Hypothesis / property-based | — | — | kısmen | kısmen |
| **APICover** | **✓** | **✓** | **✓** | **✓** |

Hiçbiri şu dördünü birleştirmez: **canlı sistem keşfi + görsel akış düzenleme + dallanan durum-uzayı taraması + dal başına regresyon tespiti.** APICover'ın doldurduğu boşluk tam olarak budur.

Kısacası: davranışları önemseyen ekipler için bir **Postman alternatifi**; sadece yüzeyi değil sistemin kendisini görmek isteyen ekipler için bir **Swagger alternatifi**.

## Nerelerde kullanılır?

- **Davranış kapsamı çıkarmak** — API'nizin bir iş akışında (sipariş, fatura, ödeme) alabileceği tüm yolları tek çalıştırmada görmek ve her dalın geçti/kaldı durumunu izlemek.
- **AI üretimi kodu anlamak ve doğrulamak** — tamamını yazmadığınız bir backend'in gerçekte ne yaptığını, IL seviyesinde çağrı grafiği incelemesiyle (DI arayüzlerinin somut karşılıkları, dış HTTP ve veritabanı sınırları dahil) dışarıdan içeriye görmek.
- **Regresyon yakalamak** — senaryoları kaydedip her değişiklikten sonra yeniden çalıştırmak; hangi *dalın* kırıldığını endpoint seviyesinde değil davranış seviyesinde görmek.
- **Postman koleksiyonu çoğaltmasından kurtulmak** — "aynı akış, farklı girdi" için koleksiyon kopyalamak yerine tek senaryoya Case Set eklemek.
- **Çok adımlı entegrasyon testleri** — glue kodu ve fixture yazmadan; path, query, header ve body alanları önceki düğümlerin yanıtlarına karşı satır içi JSONLogic ifadeleriyle beslenir.
- **Streaming endpoint'leri test etmek** — SSE, NDJSON ve ham chunk akışları; akışı erken sonlandıran koşullu `until` kuralları ile.
- **Keşif ve hata ayıklama** — breakpoint koyup düğümde durmak, isteği düzenleyip devam etmek; bir alt grafı N×M kez iterasyon başına mutasyonlarla tekrarlamak (Execution Groups).
- **Testleri AI'a yazdırmak** — IDE'nizdeki LLM'in (Cursor, Copilot, Claude Code, Cline…) MCP üzerinden endpoint envanterini okuyup senaryo taslaklamasını, çalıştırmasını ve kırılan dalları raporlamasını sağlamak. Detay aşağıda.

## Nasıl çalışır?

Kurulum iki paket ve üç satırdır:

```bash
dotnet add package APICover
dotnet add package APICover.UI.Web
```

```csharp
using APICover.Hosting;
using APICover.UI.Web;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAPICover();
builder.Services.AddAPICoverWebUI();

var app = builder.Build();
app.UseAPICover();   // tarayıcıda /apicover/ui/ adresini açın
app.MapControllers();
app.Run();
```

Uygulamanızı başlatın, `/apicover/ui/` adresini açın — endpoint'leriniz tuvalde hazır.

Öne çıkan mimari kararlar:

- **Proxy yok, SDK yok, ajan yok.** APICover süreç içi middleware'dir; route'ları ASP.NET Core'un kendi `IApiDescriptionGroupCollectionProvider`'ından okur — framework'ün yönlendirdiği neyse tam olarak onu görür, ayrıca bakım gerektiren bir spec dosyası yoktur.
- **Durum-uzayı patlamasına karşı korumalı.** Çalıştırma öncesi dal tahmincisi + çalışma zamanı sınırları (`MaxBranches`, `MaxConcurrentBranches`, `MaxLeafInvocations`), kontrolsüz büyüyecek çalıştırmaları baştan reddeder.
- **Takılabilir depolama.** Varsayılan bellek içi; SQLite, SQL Server ve PostgreSQL sağlayıcıları uygulama koduna dokunmadan takılır. Senaryolar ve çalıştırmalar JSONB tarzı doküman olarak saklanır — sürdürülecek EF migration'ı yoktur.

## Test yaşam döngüsü

Bir davranış testinin APICover içindeki yolculuğu beş aşamadan geçer:

1. **Keşif (discovery).** Uygulama ayağa kalkarken APICover, route tablosundaki her controller ve minimal-API endpoint'ini envantere alır; `EnableCallGraphInspection` açıksa her endpoint için IL çağrı grafiğini çıkarır. Yazacağınız hiçbir test var olmayan bir path'e referans veremez — envanter tek doğruluk kaynağıdır.
2. **Kompozisyon (authoring).** Tuvalde düğümleri bağlayarak ya da senaryo JSON'unu doğrudan (elle veya bir LLM'e) yazdırarak DAG'ı kurarsınız. Düğümler arası veri bağımlılıkları JSONLogic ile deklaratif tanımlanır; `scenarios.save` kayıt sırasında id formatını ve kenar bütünlüğünü (edge integrity) valide eder — kopuk graf kaydedilemez.
3. **Yürütme (execution).** Motor grafı topolojik sırayla planlar, bağımsız dalları paralel koşar, Case Set taşıyan düğümlerde fork eder. Çalıştırma canlıdır: düğüm ve dal olayları (`BranchSpawned`, `BranchCompleted`) SSE üzerinden akar; breakpoint'te durup isteği düzenleyip devam edebilir, dalı atlayabilir ya da runı iptal edebilirsiniz.
4. **Verdikt (assertion).** Her dalın her düğümü `(nodeId, BranchPath)` anahtarıyla kendi sonucunu üretir; yaprak başına pass/fail toplanır ve ağaç görünümünde hangi varyant kombinasyonunun kırıldığı doğrudan okunur. Başarısız düğümler run kaydında hata detayıyla (`statusCode`, `error`) saklanır.
5. **Regresyon (history + re-run).** Kalıcı depolama açıksa senaryolar ve run geçmişi restart'lar arasında yaşar. Aynı senaryoyu her değişiklikten sonra yeniden koşar, dal seviyesinde diff alırsınız: "endpoint hâlâ 200 dönüyor" değil, "iade akışının kısmi-ödeme varyantı kırıldı" seviyesinde sinyal.

## AI ajanları ve MCP entegrasyonu

APICover, LLM'lerle iki ayrı kanaldan konuşur — testleri elle yazmak zorunda değilsiniz:

**Gömülü Claude agent** (`APICover.Agent` paketi). Dashboard'a bir Agent sekmesi ekler: sohbet, sistem tarama (scan) iş akışı ve proje hafızası. İki kimlik modu vardır — UI'a yapıştırılan Anthropic API anahtarı ya da lokalde kurulu `claude` CLI üzerinden abonelik oturumu. Agent, keşfedilen endpoint envanterine ve çağrı grafiğine erişerek uygulamanın *içinden* senaryo taslaklar.

**MCP sunucusu** (`APICover.Mcp` paketi). Model Context Protocol üzerinden **19 tool** açar; böylece IDE'nizdeki LLM (Cursor, VS Code Copilot, Cline, Windsurf, Zed, Claude Desktop, Claude Code) APICover'ın tüm yüzeyini programatik olarak sürer. İki transport desteklenir: aynı host üzerinde **streamable HTTP** (`/apicover/mcp`) ve global dotnet tool olarak kurulan **stdio** (`APICover.Mcp.Stdio`).

Tool katalogu altı grupta toplanır:

| Grup | Tool'lar | Ne işe yarar |
|---|---|---|
| Senaryolar | `scenarios.list` · `get` · `save` · `delete` · `run` | Senaryo CRUD + tetikleme; `save` şema ve kenar bütünlüğü validasyonu yapar |
| Run'lar | `runs.list` · `list_failed` · `get` · `subscribe` | Geçmiş sorgulama; `list_failed` kırılan düğüm başına satır döner, `subscribe` ilerlemeyi canlı akıtır |
| Endpoint'ler | `endpoints.list` · `details` | Envanter projeksiyonu — alan, amaç, parametreler, örnek gövdeler, auth |
| Hafıza | `memory.list` · `read` · `write` · `append` · `delete` | Ajan hafıza kökü altında path-sandbox'lı proje bilgisi |
| Kapsam | `coverage.summary` · `uncovered_endpoints` | Ne test edildi, boşluk nerede |
| Git | `git.commit_impact` | Diff → dosya başına etkilenen senaryolar: "bu commit neyi kırar?" |

MCP güdümlü tipik bir oturum şöyle akar: LLM'e `{prefix}/api/mcp/playbook` adresinden sunulan oturum playbook'u yapıştırılır; sonrasında *"`POST /invoices` için senaryo yaz"* dediğinizde model `endpoints.details` ile gerçek şemayı okur, senaryo JSON'unu taslaklar, onayınızı alır, `scenarios.save` + `scenarios.run` ile koşturur ve `runs.subscribe` üzerinden dal sonuçlarını canlı raporlar. *"abc123 commit'i bir şey kırdı mı?"* sorusu `git.commit_impact` → etkilenen senaryoları koş → kırılan dalları özetle zincirine; *"sırada ne test etmeliyiz?"* sorusu `coverage.uncovered_endpoints` → önceliklendirilmiş öneri akışına dönüşür.

Playbook aynı zamanda ajan disiplinini de dayatır: envanterde olmayan path uydurmak yasak, `scenarios.save` öncesi payload'ı gösterip onay almak zorunlu, silme işlemleri aynı turda açık teyit ister, örnek gövdelerdeki secret'lar sohbete geri yazılamaz.

## Teknoloji

- **Backend**: .NET 8, ASP.NET Core, C# 12, EF Core 8 (depolama), JSONLogic, JSON Path
- **Frontend**: React 18, TypeScript 5.6, Vite 5.4, XyFlow 12 (tuval), Dagre (yerleşim)
- **Depolama**: bellek içi · SQLite · SQL Server · PostgreSQL
- **Lisans**: MIT

## Durum

> **0.1.0-alpha** · ön sürüm · kırıcı değişiklikler beklenir
>
> Motor + UI, paketle gelen örnek uygulamaya karşı uçtan uca çalışır durumda. 96 birim + 20 entegrasyon testi geçiyor. Genel API yüzeyi (`AddAPICover`, `UseAPICover`, `APICoverOptions`) 1.0 öncesinde değişebilir.

Denemek için repo, gerçek ve önemsiz-olmayan bir hedef görebilmeniz adına örnek bir ASP.NET Core API'si (faturalama + ödeme + kullanıcılar) içerir:

```bash
dotnet run --project samples/Utopia.Sample.WebApi
# → http://localhost:5050/apicover/ui/
```

Projenin uzun anlatımı — neden var olduğu, nelerin bittiği, sıradakiler — için [STORY.md](../../STORY.md) dosyasına bakın.
