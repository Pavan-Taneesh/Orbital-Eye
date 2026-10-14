import requests

url = "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json"
response = requests.get(url)
data = response.json()

print(f"Got {len(data)} objects")
print(data[0])
