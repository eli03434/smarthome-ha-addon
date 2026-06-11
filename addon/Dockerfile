ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8

# ── סביבת ריצה: Node.js ──
RUN apk add --no-cache nodejs npm

WORKDIR /app

# ── התקנת תלויות (שכבה נפרדת ל-cache יעיל) ──
COPY rootfs/app/package.json ./
RUN npm install --omit=dev && npm cache clean --force

# ── קוד האפליקציה ──
COPY rootfs/app/ ./

# ── סקריפט הפעלה ──
COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
