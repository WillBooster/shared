/* eslint-disable */

import {AppProps} from "@blitzjs/next"
import React from "react"
import {withBlitz} from "src/blitz-client"

function MyApp({ Component, pageProps }: AppProps) {
  const getLayout = Component.getLayout || ((page) => page)
  return getLayout(<Component {...pageProps} />)
}

export default withBlitz(MyApp)
