with open("src/app/api/boards/route.ts", "r", encoding="utf-8") as f:
    c = f.read()

c = c.replace("\\`", "`").replace("\\${", "${")

with open("src/app/api/boards/route.ts", "w", encoding="utf-8") as f:
    f.write(c)

print("fixed")
