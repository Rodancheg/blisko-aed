BLISKO AED — prototyp rejestrów AED dla miast i gmin

URUCHOMIENIE
Wymagane: współczesny Node.js z fetch i Python 3.
W katalogu projektu: node server.js
Aplikacja: http://localhost:8765/
Panel: http://localhost:8765/admin/data
Otwarte rejestry: http://localhost:8765/datasets.html
Hasło administratora jest generowane w runtime/admin-password.txt.
Nie publikuj katalogu runtime ani pliku .env.

DANE
Model 1.0.0: data-model/registry-feature.schema.json
Katalog pól: data-model/field-catalog.json
Szablony: data-model/templates/
Przykład: data-model/examples/warsaw-622.v1.geojson
JSON Warszawa używa [[lon, lat]], GeoJSON używa [lon, lat].
ID urządzenia musi być trwałe i unikalne w obrębie źródła.
W XLSX przechowuj identyfikatory i kody pocztowe jako tekst.
Wczytywany jest pierwszy arkusz; pierwszy wiersz zawiera nagłówki.
Import nie wykonuje formuł. Przed przesłaniem zapisz je jako wartości.
Limit: 15 MB, 25 000 rekordów, 200 kolumn.

AKTUALIZACJA
Rejestr źródeł i importów jest zapisywany w runtime/data-hub/.
Pełne oryginalne pliki są zachowywane w uploads/.
Niezmienne migawki i wersje publikacji są w snapshots/.
Identyczny import nie tworzy kolejnych AED ani kolejnego pakietu do rozpatrzenia.
Nowe, zmienione i brakujące rekordy wymagają decyzji administratora.
Możliwe duplikaty i punkty poza zakresem nie są domyślnie zaznaczane.
Ręczne poprawki są nakładane na źródła i pozostają po ich odświeżeniu.
Błędy odświeżania nie usuwają ostatnich opublikowanych danych.
Harmonogram działa co 24 godziny, gdy serwer pozostaje uruchomiony.
Prototyp używa atomowych plików i jednej instancji procesu serwera.

KONFIGURACJA
WARSAW_API_TOKEN: token serwera do miejskiego API Warszawy.
AED_REVIEW_DIR: katalog danych trwałych (domyślnie runtime/).
AED_PYTHON: interpreter parsera (domyślnie /usr/bin/python3).
AED_DISABLE_SYNC=1: wyłącza harmonogram źródeł.
PORT: port lokalnego serwera (domyślnie 8765).

PUBLIKACJA
Odpowiedzialny dostawca zbioru wynikowego: NIE WYZNACZONO.
Wydawcy źródeł nie są automatycznie odpowiedzialni za zbiór wynikowy.
Zatwierdzenie administratora jest decyzją o publikacji w aplikacji, a nie
weryfikacją terenową AED ani przyjęciem odpowiedzialności przez organizację.
W Dane i import można zapisać robocze ustawienia bez wskazywania organizacji.
Publiczny XML pozostaje nieaktywny do jawnego wskazania odpowiedzialnego
dostawcy, profilu w portalu i publicznego adresu HTTPS.
Wskazanie organizacji jest deklaracją administratora; nie potwierdza jej
rejestracji w portalu.
XML 1.13: /api/dane-gov.xml
MD5: /api/dane-gov.xml.md5
Podgląd administratora: /api/admin/publication/preview
Wymagane jest osobne zarejestrowanie profilu dostawcy i źródła importu
w dane.gov.pl. Sam zapis ustawień w aplikacji nie publikuje w portalu.
Oficjalny XSD: https://dane.gov.pl/static/xml/otwarte_dane_latest.xsd

OGRANICZENIA
Źródła i licencje są opisane w data-model/sources/ i provenance.
Pilotaż Bydgoszczy wymaga potwierdzenia warunków i uzupełnienia współrzędnych.
Nie potwierdzamy rzeczywistej dostępności ani sprawności urządzeń.
W tej iteracji na prośbę właściciela nie uruchamiano testów funkcjonalnych.
Kontrola składni nie stanowi dowodu poprawności wszystkich scenariuszy.
Walidacja XML w portalu i pełny przegląd WCAG pozostają do wykonania.

MATERIAŁY PROMOCYJNE — UŚCIŚLENIE MENTORÓW
Logotyp i hasło mają służyć kampanii pozyskującej dostawców danych do
dane.gov.pl: urzędy, instytucje i firmy. Materiały w outputs/ powstały
przed tym uściśleniem i wymagają dostosowania przed zgłoszeniem konkursowym.
