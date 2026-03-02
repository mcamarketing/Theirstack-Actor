FROM apify/actor-node-playwright-chrome:18

COPY package*.json ./
RUN npm --quiet set progress=false     && npm install --only=prod --no-optional     && echo "NPM install done"

COPY . ./

CMD npm start --silent
